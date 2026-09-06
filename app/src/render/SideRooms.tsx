/**
 * The side rooms off the lobby — the secret room behind the west door, the keep behind the
 * east door, the crypt down the stairs — on screen.
 *
 * ON CHAIN: zones. Each room is a value of `PlayerSlot.zone` from `ZONE_SECRET` up, and its
 * floor is `SIDE_ROOMS[i].floor` — a block of lobby floor tiles the chain holds a room seat
 * inside (`player::zone_box` / `standable`) exactly as it holds a raider on the dais. A seat
 * gets in and out through `use_door` (tag 17): the client sends it from the edge of a REFUSED
 * step — into the wall from the door's threshold tiles, into the room's edge from its exit
 * tiles ({@link knockDir}) — so the knock is the same refusal a wall gives, and the chain
 * moves the seat, not the client. Every step inside is a `move` like any other.
 *
 * ON SCREEN: room A with the chamber painted over it. `siderooms.gen.ts` places each painting
 * so its floor IS the chain's block (held below at boot), so every seat in the zone is drawn
 * by the ordinary knight layer at its chain position, with no offset anywhere; the veil under
 * the painting hides the waiting area and `Arena.tsx`'s `seatShown` hides the seats on the
 * other side of the wall. Mounted right after the room element, before every mover.
 * Pointer-transparent, and nothing here writes a transform any other node owns.
 *
 * What the rooms SHOW is the chain's, read through the Worker: the keep's tablets are the
 * leaderboard ring, its chest the treasury that pays for every match, its mirror the local
 * seat's own atlas frame; the crypt's slabs are the ring grouped by incarnation.
 */
import { useMemo } from 'react';

import {
  OUTCOME_ENRAGE,
  OUTCOME_WIN,
  OUTCOME_WIPE,
  SIDE_ROOMS,
  ZONE_LOBBY,
  inBlock,
  raiderTag,
  sideRoomOf,
  type PlayerSlot,
  type SideRoom as SideRoomSpec,
} from '@heartrot/client';

import { useLeaderboard, type LeaderboardRow } from '../net/leaderboard';
import { useTreasury } from '../net/treasury';
import { Sprite } from './Knight';
import { FRAMES, KNIGHT_SKINS, type SkinId } from './knights.gen';
import { roomGlow } from './RoomLight';
import { VOID, type WorldRect } from './rooms.gen';
import { CRYPT_GLYPH, SIDE_ROOM_ART, type SideRoomArt, type SideRoomName } from './siderooms.gen';
import { ARENA_UNITS, PAL } from './sprites';

/** Nothing of the hall shows behind a room: the veil is the void itself. */
const VEIL_OPACITY = 1;
/** The line height of the rooms' text, in units, and where a line's baseline starts. */
const LINE = 7;
const LINE_TOP = 6.5;
/** The reflection's scale in the mirror, and how many tablet rows the keep carves. */
const MIRROR_SCALE = 1.6;
const ROWS_PER_TABLET = 3;
const LAMPORTS_PER_SOL = 1_000_000_000;

const artOf = (room: SideRoomSpec): SideRoomArt => SIDE_ROOM_ART[room.name as SideRoomName];

/** The glow every door answers in: the torch beside the first one. */
export const DOOR_GLOW: string = SIDE_ROOM_ART.secret.lights[0]?.color ?? PAL.ventOpen;

/**
 * The direction that knocks from here, or `null`: a room's `knock` from its door tiles in
 * the lobby, its `leave` from its exit tiles inside. `App.tsx` asks this when the predictor
 * refuses a step — refused there, in this direction, from here, it is a door being pushed —
 * and sends `use_door`.
 */
export function knockDir(zone: number, x: number, y: number): number | null {
  if (zone === ZONE_LOBBY) {
    for (const room of SIDE_ROOMS) if (inBlock(room.door, x, y)) return room.knock;
    return null;
  }
  const room = sideRoomOf(zone);
  return room !== null && inBlock(room.exit, x, y) ? room.leave : null;
}

/** The painted doorway a seat standing at (`x`, `y`) in `zone` is about to push, for the glow. */
export function archAt(zone: number, x: number, y: number): WorldRect | null {
  if (zone === ZONE_LOBBY) {
    for (const room of SIDE_ROOMS) if (inBlock(room.door, x, y)) return artOf(room).archLobby;
    return null;
  }
  const room = sideRoomOf(zone);
  return room !== null && inBlock(room.exit, x, y) ? artOf(room).archRoom : null;
}

const WORD: Readonly<Record<number, string>> = { 0: 'north', 2: 'east', 4: 'south', 6: 'west' };

/** The hint's "WALK … to leave" for a seat in `zone`, or `null` outside every room. A string, so a selector returning it is stable. */
export function leaveWay(zone: number): string | null {
  const room = sideRoomOf(zone);
  if (room === null) return null;
  return `${WORD[room.leave] ?? ''} ${room.name === 'crypt' ? 'up the stairs' : 'through the door'}`;
}

// ---------------------------------------------------------------------------
// The crypt's reading of the ring
// ---------------------------------------------------------------------------

export interface Incarnation {
  arenaId: string;
  incarnation: number;
  outcome: number;
  raiders: number;
  survivors: number;
  damage: number;
}

/**
 * The ring's rows — one per seated raider per settle — folded into one entry per
 * incarnation, newest first (the newest arena, then its latest incarnation). Pure.
 */
export function incarnationsOf(rows: readonly LeaderboardRow[]): Incarnation[] {
  const by = new Map<string, Incarnation>();
  for (const r of rows) {
    const key = `${r.arenaId}:${r.incarnation}`;
    const inc = by.get(key) ?? { arenaId: r.arenaId, incarnation: r.incarnation, outcome: r.outcome, raiders: 0, survivors: 0, damage: 0 };
    inc.raiders += 1;
    inc.survivors += r.survived ? 1 : 0;
    inc.damage += r.damage;
    by.set(key, inc);
  }
  return [...by.values()].sort((a, b) => {
    const A = BigInt(a.arenaId);
    const B = BigInt(b.arenaId);
    return A === B ? b.incarnation - a.incarnation : A < B ? 1 : -1;
  });
}

const GLYPH_OF: Readonly<Record<number, (typeof CRYPT_GLYPH.names)[number] | undefined>> = {
  [OUTCOME_WIN]: 'crown',
  [OUTCOME_WIPE]: 'skull',
  [OUTCOME_ENRAGE]: 'hourglass',
};

/** `41,250` under five digits, `41.3k` above: the slabs are narrow. */
function short(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString('en-US');
}

const OUTCOME_WORD: Readonly<Record<number, string>> = { [OUTCOME_WIN]: 'KILL', [OUTCOME_WIPE]: 'WIPE', [OUTCOME_ENRAGE]: 'ENRAGE' };

// ---------------------------------------------------------------------------
// The rooms
// ---------------------------------------------------------------------------

/** Lines of text down an anchor, from its top, centred. */
function Lines({ box, lines, top = LINE_TOP }: { box: WorldRect; lines: readonly { text: string; you?: boolean; dim?: boolean }[]; top?: number }) {
  const cx = box.x + box.w / 2;
  return (
    <>
      {lines.map((l, i) => (
        <text
          key={i}
          className={`room-text${l.you ? ' is-you' : ''}${l.dim ? ' is-dim' : ''}`}
          x={cx}
          y={box.y + top + i * LINE}
          textAnchor="middle"
        >
          {l.text}
        </text>
      ))}
    </>
  );
}

function Keep({ art, local }: { art: SideRoomArt; local: PlayerSlot | undefined }) {
  const { rows, total, failed } = useLeaderboard();
  const treasury = useTreasury();
  const you = local === undefined ? null : raiderTag(local.identity);
  const tablets = [art.anchors.tablet0, art.anchors.tablet1, art.anchors.tablet2].filter((t): t is WorldRect => t !== undefined);
  const skin = (local !== undefined && Number.isInteger(local.skinId) && local.skinId >= 0 && local.skinId < KNIGHT_SKINS.length ? local.skinId : 0) as SkinId;
  const [, , fw, fh] = FRAMES[`${skin}-s-idle`];
  const mirror = art.anchors.mirror;
  const chest = art.anchors.chest;
  const records = tablets[1];
  return (
    <>
      {tablets.map((box, t) => {
        const slice = rows?.slice(t * ROWS_PER_TABLET, (t + 1) * ROWS_PER_TABLET) ?? [];
        const lines =
          rows === null
            ? t === 1
              ? [{ text: failed ? 'unread' : 'reading…', dim: true }]
              : []
            : slice.flatMap((r) => [
                { text: `${r.rank} ${r.raider}`, you: r.raider === you },
                { text: `${short(r.damage)} ${OUTCOME_WORD[r.outcome] ?? ''}`.trim(), you: r.raider === you, dim: true },
              ]);
        return <Lines key={t} box={box} lines={lines} />;
      })}
      {records !== undefined && total !== null && (
        <text className="room-text is-dim" x={records.x + records.w / 2} y={records.y + records.h + 22} textAnchor="middle">
          {total.toLocaleString('en-US')} raider {total === 1 ? 'run' : 'runs'} recorded
        </text>
      )}
      {chest !== undefined && (
        <Lines
          box={chest}
          lines={
            treasury === null
              ? [{ text: 'reading…', dim: true }]
              : [{ text: `${(treasury.lamports / LAMPORTS_PER_SOL).toFixed(3)} SOL` }, { text: `~${treasury.matches} matches · you pay nothing`, dim: true }]
          }
        />
      )}
      {mirror !== undefined && local !== undefined && (
        // Your reflection: the atlas's own frame, mirrored, a little larger than life. The
        // frame's centre is the sprite's centre, as `Knight.tsx` draws it.
        <g transform={`translate(${mirror.x + mirror.w / 2} ${mirror.y + mirror.h / 2 + 4}) scale(${-MIRROR_SCALE} ${MIRROR_SCALE})`}>
          <Sprite frame={`halo${skin}-s-idle`} x={-(fw >> 1)} y={-(fh >> 1)} />
          <Sprite frame={`${skin}-s-idle`} x={-(fw >> 1)} y={-(fh >> 1)} />
        </g>
      )}
    </>
  );
}

function Crypt({ art }: { art: SideRoomArt }) {
  const { rows } = useLeaderboard(true);
  const incarnations = useMemo(() => (rows === null ? [] : incarnationsOf(rows)), [rows]);
  const slabs = Array.from({ length: 8 }, (_, i) => art.anchors[`slab${i}`]).filter((s): s is WorldRect => s !== undefined);
  const g = CRYPT_GLYPH.w;
  return (
    <>
      {slabs.map((box, i) => {
        const inc = incarnations[i];
        if (inc === undefined) return null;
        const glyph = GLYPH_OF[inc.outcome];
        return (
          <g key={i}>
            {glyph !== undefined && <use href={`#crypt-${glyph}`} x={box.x + box.w / 2 - g / 2} y={box.y + 2} width={g} height={g} />}
            <Lines
              box={box}
              top={g + 4 + LINE_TOP}
              lines={[
                { text: `INC ${inc.incarnation}` },
                { text: `${inc.raiders} raider${inc.raiders === 1 ? '' : 's'}`, dim: true },
                { text: `${inc.survivors} lived`, dim: true },
                { text: `${short(inc.damage)} dmg`, dim: true },
              ]}
            />
          </g>
        );
      })}
    </>
  );
}

export function SideRoom({ zone, local }: { zone: number; local: PlayerSlot | undefined }) {
  const room = sideRoomOf(zone);
  if (room === null) return null;
  const art = artOf(room);
  return (
    <g className="secret-room" role="img" aria-label={`A side room: the ${room.name}`} style={{ pointerEvents: 'none' }}>
      <rect x={-ARENA_UNITS} y={-ARENA_UNITS} width={3 * ARENA_UNITS} height={3 * ARENA_UNITS} fill={VOID.lobby} opacity={VEIL_OPACITY} />
      <image href={art.img.src} x={art.img.x} y={art.img.y} width={art.img.w} height={art.img.h} preserveAspectRatio="none" style={{ imageRendering: 'auto' }} />
      {roomGlow(`side-glow-${room.name}`, art.lights)}
      {art.labels.map((l, i) => (
        <text key={i} className={i === art.labels.length - 1 ? 'secret-caption' : 'secret-label'} x={l.x} y={l.y} textAnchor="middle">
          {l.text}
        </text>
      ))}
      {room.name === 'keep' && <Keep art={art} local={local} />}
      {room.name === 'crypt' && <Crypt art={art} />}
    </g>
  );
}

if (import.meta.env.DEV) {
  const fail = (msg: string): never => {
    throw new Error(`SideRooms: ${msg}`);
  };
  // Each painting's floor and the chain's block are one fact: a seat in the zone is drawn
  // on the cobbles only while these four numbers agree, room by room.
  for (const room of SIDE_ROOMS) {
    const f = artOf(room)?.floor;
    if (f === undefined) fail(`no painting for ${room.name}; re-run tools/gen_side_rooms.py`);
    const b = room.floor;
    if (f.x !== b.minX || f.y !== b.minY || f.x + f.w - 1 !== b.maxX || f.y + f.h - 1 !== b.maxY) fail(`${room.name}'s painted floor is not its block`);
    // The two thresholds answer in the two directions the chain crosses them in, and nowhere else.
    const zone = ZONE_LOBBY + 2 + SIDE_ROOMS.indexOf(room);
    if (knockDir(ZONE_LOBBY, room.door.minX, room.door.minY) !== room.knock) fail(`${room.name}'s door does not knock`);
    if (knockDir(zone, room.exit.minX, room.exit.maxY) !== room.leave) fail(`${room.name}'s exit does not knock`);
    if (knockDir(ZONE_LOBBY, room.exit.minX, room.exit.minY) !== null) fail(`a lobby seat knocks from inside ${room.name}`);
    if (knockDir(zone, room.floor.minX, room.floor.minY) !== null && !inBlock(room.exit, room.floor.minX, room.floor.minY)) fail(`${room.name}'s far corner knocks`);
  }
  // The crypt's fold: two arenas, three incarnations, newest first, counted right.
  const row = (arenaId: string, incarnation: number, outcome: number, damage: number, survived: boolean): LeaderboardRow => ({
    rank: 1, raider: 'aaaa…zzzz', damage, outcome, incarnation, survived, arenaId,
  });
  const folded = incarnationsOf([
    row('1', 3, OUTCOME_WIPE, 100, false),
    row('1', 3, OUTCOME_WIPE, 250, true),
    row('1', 4, OUTCOME_WIN, 900, true),
    row('2', 1, OUTCOME_ENRAGE, 5, false),
  ]);
  if (folded.length !== 3 || folded[0]!.arenaId !== '2' || folded[1]!.incarnation !== 4 || folded[2]!.raiders !== 2 || folded[2]!.survivors !== 1 || folded[2]!.damage !== 350) {
    fail('incarnationsOf folds the ring wrong');
  }
}
