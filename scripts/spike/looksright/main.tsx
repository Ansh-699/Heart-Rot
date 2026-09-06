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
import { attachControls } from '../../../app/src/input/controls';
import {
  ARENA, BOSS, BOSS_SPAWN, BULLET, MUZZLES, PLAYERS, PLAYER_SLOT, DISC_ARENA, DISC_BOSS, DISC_PLAYERS,
  LAYOUT_VERSION, MAX_SEATS, N_PARTS, CLASS_MASK,
  PHASE_LOBBY, PHASE_FIGHTING, PHASE_MUSTERING, ZONE_ARENA, ZONE_LOBBY, ZONE_SECRET,
  SIDE_ROOMS,
  autoAim, decodeAim, decodeArena, decodeBoss, decodePlayers,
  type BossAccount,
} from '@heartrot/client';

const blank = (size: number, disc: number) => {
  const d = new Uint8Array(size);
  d[0] = disc; d[1] = LAYOUT_VERSION; d[2] = 255;
  return { d, v: new DataView(d.buffer) };
};

/** Byte offset of bullet `i`'s x field. */
const b0 = (o: typeof ARENA.offsets, i: number): number => o.bullets + i * BULLET.size + BULLET.offsets.x;

function arenaBytes(phase: number, tick: number, bullets: number, outcome = 0, incarnation = 0, dead: number[] = []) {
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
  // VOLLEYS LEAVE THE CREATURE, which is the whole of what a fake volley has to get right.
  // This used to scatter bullets around a circle centred on the floor, so the footage showed
  // fireballs streaming out of empty stone with nothing throwing them — the first thing the
  // owner said about the landing clip. `tick.rs::spawn_volley` is the rule: a bullet leaves
  // `boss + MUZZLES[i]`, one emitter per thorn, and only while that thorn is alive. Same
  // muzzle table, same liveness gate, so a torn-off arm stops shooting here exactly as it
  // does on chain.
  const live = MUZZLES.filter((m) => !dead.includes(m.part));
  if (live.length > 0) {
    const step = ((tick % 14) + 14) % 14;
    for (let i = 0; i < bullets; i++) {
      const m = live[i % live.length]!;
      const mx = BOSS_SPAWN[0] + m.x;
      const my = BOSS_SPAWN[1] + m.y;
      // Fanned into the pit rather than radially: the raiders are down there, and a volley
      // that ignores them reads as decoration. Spread is deterministic per bullet so the
      // pattern is stable frame to frame and the flight below is a straight line.
      const spread = ((i * 5) % 9) / 8 - 0.5;
      const ax = spread * 1.9;
      const ay = 1;
      const len = Math.hypot(ax, ay);
      const ux = ax / len;
      const uy = ay / len;
      // Distance travelled since this bullet left the muzzle. Wrapping on a period longer
      // than the flight keeps a steady stream without every bullet restarting together.
      const fly = (((step + i * 3) % 14) / 14) * 520;
      v.setInt16(b0(o, i), Math.round(mx + ux * fly), true);
      v.setInt16(b0(o, i) + (BULLET.offsets.y - BULLET.offsets.x), Math.round(my + uy * fly), true);
      const b = o.bullets + i * BULLET.size;
      v.setInt8(b + BULLET.offsets.dx, Math.round(ux * 42));
      v.setInt8(b + BULLET.offsets.dy, Math.round(uy * 42));
      v.setUint8(b + BULLET.offsets.active, 1);
    }
  }
  return decodeArena(d);
}

/**
 * `vent`: the shell sits just under the solo threshold (98 %) so the vent is open and the
 * quiet ring shows. `fury`: the same plus a core at 300 of 2,000 — with 90 shell to strip
 * the effective pool is 2,090 and 300 is under 20 % of it, so `isFurious` reads true.
 */
function bossBytes(hurt: boolean, vent = false, fury = false, dead: number[] = [], core?: number, tick = 900) {
  const { d, v } = blank(BOSS.size, DISC_BOSS);
  const o = BOSS.offsets;
  v.setInt16(o.x, BOSS_SPAWN[0], true);
  v.setInt16(o.y, BOSS_SPAWN[1], true);
  // The volley's clock, on the tick like the slam's: `attack_timer` counts down to a
  // volley at 915 (+32 n), so 900..914 is the wind-up window `Arena.tsx` draws the
  // lock and the thorn glow through, at seat 0 (blank `target_seat`, the local seat).
  v.setUint8(o.attack_timer, (((915 - tick) % 32) + 32) % 32);
  const open = vent || fury;
  for (let i = 0; i < N_PARTS; i++) {
    v.setUint16(o.parts_max + i * 2, 500, true);
    // `dead` names the destroyed parts outright (the heads, for the torn-off shot); the
    // fury default strips the mace, the claws and a thorn.
    const gone = dead.length ? dead.includes(i) : (hurt && i === 7) || (fury && (i === 7 || i === 8 || i === 3));
    const hp = gone ? 0 : open && i === 0 ? 400 : 500;
    v.setUint16(o.parts + i * 2, hp, true);
  }
  v.setUint8(o.vent_open, open ? 1 : 0);
  v.setUint16(o.core_hp, core ?? (fury ? 300 : 2000), true);
  v.setUint16(o.core_hp_max, 2000, true);
  return decodeBoss(d);
}

/**
 * The aim half of `class_aim`, packed the way `PlayerSlot::set_aim` packs it
 * (`programs/heartrot/src/state.rs`): bits 6..4 sector `neg_x << 2 | neg_y << 1 | steep`,
 * bits 3..0 `min/max` scaled 0..15, rounded to nearest the same way. Bit 7 (class) is the
 * caller's to OR in — the same split the chain keeps.
 *
 * `decodeAim` in `packages/client/src/layout.ts` is the inverse and is what `Shot.tsx`
 * draws along, so the check below round-trips through it rather than restating the maths.
 */
function aimByte(dx: number, dy: number): number {
  const rx = Math.round(dx), ry = Math.round(dy);
  const ax = Math.abs(rx), ay = Math.abs(ry);
  const sector = (rx < 0 ? 4 : 0) | (ry < 0 ? 2 : 0) | (ay > ax ? 1 : 0);
  const min = Math.min(ax, ay), max = Math.max(ax, ay);
  return (sector << 4) | (max === 0 ? 0 : Math.floor((min * 15 + (max >> 1)) / max));
}

// The one thing in this file that can be wrong silently: an arrow that flies the wrong way
// still draws. Round-trip through the shipped decoder at load, so a bad frame is a console
// error and not a mystery in the footage.
for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [3, -9], [-40, -17], [200, 130], [-7, 7]]) {
  const [ax, ay] = decodeAim(aimByte(dx, dy));
  const err = Math.abs(Math.atan2(dy, dx) - Math.atan2(ay, ax)) * 180 / Math.PI;
  if (!(err < 1.92)) console.error('aimByte round-trip', dx, dy, '->', ax, ay, err.toFixed(2), 'deg');
}

/**
 * A firing line rather than a parade: two interleaved ranks on an arc under the boss,
 * wider than it is deep because the pit is (the `P` block in `map.ts`). Rank 1 sits far
 * enough back that its arrows fly ~180 ms instead of ~90, so three ticks of volleys are in
 * the air at once instead of one.
 */
function ringSeat(seat: number, seats: number): [number, number] {
  const rank = seat % 2;
  const n = Math.max(1, Math.ceil(seats / 2));
  const i = (seat - rank) / 2;
  // A deterministic nudge off the lattice — an evenly-stepped arc photographs as a chorus
  // line. Seeded on the seat, so a scene re-issued at 10 Hz does not shimmer.
  const j = (k: number) => ((Math.sin(seat * 127.1 + k) * 43758.5453) % 1 + 1) % 1 - 0.5;
  const a = Math.PI * (0.06 + 0.88 * (n === 1 ? 0.5 : i / (n - 1)) + 0.03 * j(0));
  const rx = (rank ? 440 : 300) + 46 * j(7), ry = (rank ? 205 : 128) + 22 * j(3);
  return [Math.round(BOSS_SPAWN[0] - Math.cos(a) * rx), Math.round(BOSS_SPAWN[1] + Math.sin(a) * ry)];
}

/**
 * Where a seat points. `BOSS_SPAWN` is the creature's FEET — every box in `PART_HITBOXES`
 * sits above it — so a ray at that point sails clean under the shell and terminates on the
 * far wall, which is what twenty arrows crossing the room and leaving the pit looked like.
 * `autoAim` is the shipped answer to the same question (nearest live part, or the open
 * core), so the harness asks it rather than keeping a second one. `null` — nothing on the
 * creature is reachable — falls back to the spawn, which is the shot's own fallback too.
 */
function aimAtBoss(x: number, y: number, boss: BossAccount): number {
  const a = autoAim(x, y, boss);
  return a === null ? aimByte(BOSS_SPAWN[0] - x, BOSS_SPAWN[1] - y) : aimByte(a[0], a[1]);
}

/** 20 seats spread over the room named by `zone`, mixed skins and classes. `damage` is
 *  per seat, for the results panel's placing; the default is a spread nobody ties on. */
function playersBytes(zone: number, tick: number, seats: number, boss: BossAccount, at?: number[][], damage?: number[], localHp?: number, ring?: boolean) {
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
    const col = seat % 5, row = (seat / 5) | 0;
    const [rx, ry] = ringSeat(seat, seats);
    const x = ring ? rx : zone === ZONE_ARENA ? 180 + col * 168 + row * 22 : 150 + col * 180 + row * 26;
    const y = ring ? ry : zone === ZONE_ARENA ? 430 + row * 44 : 700 + row * 72;
    // Aim at the boss from where this seat actually stands, so twenty arrows converge
    // instead of twenty arrows all leaving down-right (the old flat `0x18`).
    v.setUint8(s + PLAYER_SLOT.offsets.class_aim, (seat % 2 ? CLASS_MASK : 0) | aimAtBoss(x, y, boss));
    v.setInt16(s + PLAYER_SLOT.offsets.x, x, true);
    v.setInt16(s + PLAYER_SLOT.offsets.y, y, true);
    // Seat 0 is the local seat (`/api/session/init` below); `localHp` 0 is the fallen card.
    const hp = seat === 0 && localHp !== undefined ? localHp : seat === 7 ? 34 : 100;
    v.setUint16(s + PLAYER_SLOT.offsets.hp, hp, true);
    v.setUint16(s + PLAYER_SLOT.offsets.hp_max, 100, true);
    v.setUint16(s + PLAYER_SLOT.offsets.deaths, hp === 0 ? 1 : 0, true);
    // `Shot.tsx` launches a REMOTE arrow on a VALUE DIFF of this, so what matters is that
    // it CHANGES, on the archer's 4-tick period, at a different tick per seat. `seat * 3`
    // against a period of 4 is coprime, so consecutive seats land on all four phases and
    // five of twenty loose on any given tick — a continuous volley, never a salvo.
    v.setUint32(s + PLAYER_SLOT.offsets.last_shot_tick,
      tick > 4 ? 1 + Math.floor((tick + seat * 3) / 4) : 0, true);
    v.setUint32(s + PLAYER_SLOT.offsets.damage_dealt, damage?.[seat] ?? seat * 137, true);
  }
  return decodePlayers(d);
}

setAuthSource(async () => 'stub.jwt.token');
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  if (url.includes('/api/leaderboard')) {
    // Twelve runs over three incarnations of two arenas, two outcomes, so the keep's tablets
    // and the crypt's slabs have something to say.
    const rows = [
      [1, 'ab12…zz90', 41250, 2, 12, false, '7'], [2, 'cd34…yy81', 30110, 2, 12, true, '7'], [3, 'ef56…xx72', 22400, 1, 11, true, '7'],
      [4, 'gh78…ww63', 19870, 1, 11, true, '7'], [5, 'ij90…vv54', 15020, 1, 11, false, '7'], [6, 'kl12…uu45', 12800, 3, 10, false, '7'],
      [7, 'mn34…tt36', 9900, 3, 10, false, '7'], [8, 'op56…ss27', 8400, 2, 12, false, '7'], [9, 'qr78…rr18', 7100, 2, 3, true, '6'],
      [10, 'st90…qq09', 5600, 2, 3, false, '6'], [11, 'uv12…pp00', 4200, 1, 2, true, '6'], [12, 'wx34…oo11', 3000, 1, 2, true, '6'],
    ].map(([rank, raider, damage, outcome, incarnation, survived, arenaId]) => ({ rank, raider, damage, outcome, incarnation, survived, arenaId }));
    return new Response(JSON.stringify({ rows, total: 1287 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.includes('/api/faucet/status')) {
    return new Response(JSON.stringify({ treasury: '11111111111111111111111111111111', treasuryLamports: '2731450000', estimatedMatches: 41, tier: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
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
  /** An explicit tick, over the default (900 in the arena, 0 in the lobby). */
  tick?: number;
  /** Which `Boss.parts` slots are destroyed, over the fury default (4 crown, 5 wolf, 6 beast). */
  dead?: number[];
  /** The local seat's hp; 0 photographs the fallen card over its corpse. */
  localHp?: number;
  /** The boss's core hp, over the fury/normal defaults — lower it between two scenes for a core hit. */
  core?: number;
  /** Stand the seats in a combat arc around the boss instead of the default 5-column grid. */
  ring?: boolean;
}

function Bridge() {
  const store = useStore();
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__store = store;
    w.__scene = (which: 'lobby' | 'arena' | 'secret' | 'keep' | 'range', opts: SceneOpts = {}) => {
      const arena = which === 'arena';
      const room = SIDE_ROOMS.findIndex((r) => r.name === which);
      const zone = room >= 0 ? ZONE_SECRET + room : arena ? ZONE_ARENA : ZONE_LOBBY;
      // A room scene without placements: the local seat at the room's entry, the rest
      // fanned across its floor, so nobody is drawn outside the walls.
      if (room >= 0 && opts.at === undefined) {
        const f = SIDE_ROOMS[room]!.floor;
        const n = opts.seats ?? 3;
        opts = {
          ...opts,
          at: Array.from({ length: n }, (_, i) =>
            i === 0
              ? [SIDE_ROOMS[room]!.entry[0], SIDE_ROOMS[room]!.entry[1], 2, 1]
              : [f.minX + 32 + ((i * 96) % (f.maxX - f.minX - 48)), f.minY + 48 + ((i * 40) % (f.maxY - f.minY - 64)), i % 3, 1],
          ),
        };
      }
      const tick = opts.tick ?? (arena ? 900 : 0);
      // The boss first: the seats aim at the shell this scene actually has, so a stripped
      // part re-targets the raid the way `autoAim` re-targets a real player.
      const boss = bossBytes(!!opts.hurt, !!opts.vent, !!opts.fury, opts.dead, opts.core, tick);
      store.setWorld({
        from: '11111111111111111111111111111111',
        arena: arenaBytes(opts.phase ?? (arena ? PHASE_FIGHTING : PHASE_LOBBY), tick,
          arena ? (opts.bullets ?? 10) : 0, opts.outcome ?? 0, opts.incarnation ?? 0,
          // The same `dead` the boss is built from: a torn-off thorn stops emitting here
          // exactly as it stops on chain.
          opts.dead ?? (opts.fury ? [7, 8, 3] : opts.hurt ? [7] : [])),
        boss,
        players: playersBytes(zone, tick, opts.seats ?? MAX_SEATS, boss, opts.at, opts.damage, opts.localHp, opts.ring),
      });
    };
    w.__PHASE = { PHASE_LOBBY, PHASE_FIGHTING, PHASE_MUSTERING };
    // The local seat's own feedback, driven directly: a practice loose at any tier and the
    // hold's edge, so the beam and the draw can be photographed without a chain.
    w.__fire = fireLocal;
    w.__charge = chargeLocal;
    // touch-input: the real controls on the real stage with a lobby clock, every intent
    // appended to `log` as [performance.now(), kind, value] so a harness can drive fingers
    // through CDP and read what left. The app's own attach never happens here (its chain
    // connect fails), so this is the one way to test input against the shipped listeners.
    w.__attachControls = (log: unknown[][]) => attachControls({
      surface: document.getElementById('stage')!,
      clock: () => ({ phase: PHASE_LOBBY, tick: 0 }),
      aim: () => [0, -127],
      onMove: (dir) => log.push([performance.now(), 'move', dir]),
      onTrigger: (_dx, _dy, tier) => log.push([performance.now(), 'trigger', tier]),
      onShoot() {},
      onCharge: (t) => log.push([performance.now(), 'charge', t]),
    });
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
