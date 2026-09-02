/**
 * Throwaway harness for docs/review/render.md finding 1: does the arena survive the gate?
 *
 * Mounts the REAL `app/src/App.tsx` — Privy is installed in `main.tsx`, not in `App`, so
 * the shell needs only a stubbed `AuthSource` and a stubbed `/api/session/init`. Nothing
 * is mocked below the store: the same `StoreProvider`, the same `screenOf` router, the
 * same `World` portal, the same `Scene.tsx` module-scope `SCENE`.
 *
 * The measurement is DOM node identity across the lobby -> arena flip. If the portal
 * remounts, every node inside `#stage` is replaced and the old ones are disconnected.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from '../../../app/src/App';
import { StoreProvider, setAuthSource } from '../../../app/src/state/store';
import {
  ARENA, BOSS, BOSS_SPAWN, PLAYERS, PLAYER_SLOT, DISC_ARENA, DISC_BOSS, DISC_PLAYERS, LAYOUT_VERSION,
  MAX_SEATS, N_PARTS, PHASE_LOBBY, PHASE_FIGHTING, ZONE_ARENA, ZONE_LOBBY,
  decodeArena, decodeBoss, decodePlayers,
} from '@heartrot/client';

// --- fixtures: real bytes through the real decoders ------------------------
const blank = (size: number, disc: number) => {
  const d = new Uint8Array(size);
  d[0] = disc; d[1] = LAYOUT_VERSION; d[2] = 255;
  return { d, v: new DataView(d.buffer) };
};
function arenaBytes(phase = PHASE_LOBBY) {
  const { d, v } = blank(ARENA.size, DISC_ARENA);
  v.setUint8(ARENA.offsets.phase, phase);
  v.setBigUint64(ARENA.offsets.arena_id, 1n, true);
  return decodeArena(d);
}
function bossBytes() {
  const { d, v } = blank(BOSS.size, DISC_BOSS);
  v.setInt16(BOSS.offsets.x, BOSS_SPAWN[0], true);
  v.setInt16(BOSS.offsets.y, BOSS_SPAWN[1], true);
  for (let i = 0; i < N_PARTS; i++) {
    v.setUint16(BOSS.offsets.parts + i * 2, 500, true);
    v.setUint16(BOSS.offsets.parts_max + i * 2, 500, true);
  }
  v.setUint16(BOSS.offsets.core_hp, 2000, true);
  v.setUint16(BOSS.offsets.core_hp_max, 2000, true);
  return decodeBoss(d);
}
function playersBytes(zone: number) {
  const { d, v } = blank(PLAYERS.size, DISC_PLAYERS);
  for (let seat = 0; seat < 3; seat++) {
    const s = PLAYERS.offsets.slots + seat * PLAYER_SLOT.size;
    d[s + PLAYER_SLOT.offsets.session_pubkey] = seat + 1;
    v.setUint8(s + PLAYER_SLOT.offsets.zone, seat === 0 ? zone : ZONE_LOBBY);
    v.setUint8(s + PLAYER_SLOT.offsets.skin_id, seat % 3);
    v.setInt16(s + PLAYER_SLOT.offsets.x, 448 + seat * 16, true);
    v.setInt16(s + PLAYER_SLOT.offsets.y, zone === ZONE_ARENA && seat === 0 ? 500 : 832, true);
    v.setUint16(s + PLAYER_SLOT.offsets.hp, 100, true);
    v.setUint16(s + PLAYER_SLOT.offsets.hp_max, 100, true);
  }
  return decodePlayers(d);
}

// --- stubs: identity and the one Worker route the shell needs to reach ------
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
      // Deliberately unroutable: the ER link is irrelevant to a portal-identity question,
      // and a failed link is the harsher case (predictor undefined, every seat interpolated).
      erEndpoint: 'http://127.0.0.1:1/er', routerEndpoint: 'http://127.0.0.1:1/router',
      tickMs: 100,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

// The driver needs the SAME store React is using, and `StoreProvider` builds its own with
// `useMemo(createStore, [])`. A one-line bridge inside the provider hands it out; nothing
// in product code changes.
import { createElement, useEffect } from 'react';
import { useStore } from '../../../app/src/state/store';

function Bridge() {
  const store = useStore();
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__store = store;
    w.__world = (zone: number, phase = PHASE_LOBBY) =>
      store.setWorld({ arena: arenaBytes(phase), boss: bossBytes(), players: playersBytes(zone) });
    w.__PHASE = { PHASE_LOBBY, PHASE_FIGHTING };
    w.__ZONE = { ZONE_ARENA, ZONE_LOBBY, MAX_SEATS };
    w.__ready = true;
  }, [store]);
  return null;
}

const root = createRoot(document.getElementById('root')!);
root.render(
  createElement(
    StrictMode,
    null,
    createElement(StoreProvider, { children: [createElement(Bridge, { key: 'b' }), createElement(App, { key: 'a' })] }),
  ),
);
