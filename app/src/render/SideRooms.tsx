/**
 * The side rooms off the lobby — the secret room behind the west door, the keep behind the
 * east door, the range down the stairs — on screen.
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
 * seat's own atlas frame. The range's straw men are the one thing a practice arrow — an
 * on-chain shot, `shoot.rs`'s practice path — can stop on: {@link roomRay} cuts the tracer
 * where the room's own geometry says, as the boss raycast does in the pit.
 */
import { useEffect, useRef, useState } from 'react';

import {
  OUTCOME_ENRAGE,
  OUTCOME_WIN,
  OUTCOME_WIPE,
  SIDE_ROOMS,
  ZONE_LOBBY,
  aimFromVector,
  inBlock,
  raiderTag,
  sideRoomOf,
  type PlayerSlot,
  type SideRoom as SideRoomSpec,
} from '@heartrot/client';

import { useLeaderboard } from '../net/leaderboard';
import { useTreasury } from '../net/treasury';
import { Sprite } from './Knight';
import { FRAMES, KNIGHT_SKINS, type SkinId } from './knights.gen';
import { roomGlow } from './RoomLight';
import { VOID, type WorldRect } from './rooms.gen';
import { SIDE_ROOM_ART, type DoorKind, type SideRoomArt, type SideRoomName } from './siderooms.gen';
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

/** A doorway a seat is standing at: which open frame to draw, and where. */
export interface DoorAt {
  readonly kind: DoorKind;
  readonly rect: WorldRect;
}

/**
 * The painted doorway a seat standing at (`x`, `y`) in `zone` is about to push, drawn OPEN:
 * the arch with its leaf gone and the room's light in it, or the stair lit. A picture in
 * the painting's own hand, not a tint — the one cue the doors give, from both sides.
 */
export function doorAt(zone: number, x: number, y: number): DoorAt | null {
  if (zone === ZONE_LOBBY) {
    for (const room of SIDE_ROOMS) {
      if (inBlock(room.door, x, y)) {
        const art = artOf(room);
        return { kind: art.doorLobby, rect: art.archLobby };
      }
    }
    return null;
  }
  const room = sideRoomOf(zone);
  if (room === null || !inBlock(room.exit, x, y)) return null;
  const art = artOf(room);
  return { kind: art.doorRoom, rect: art.archRoom };
}

const WORD: Readonly<Record<number, string>> = { 0: 'north', 2: 'east', 4: 'south', 6: 'west' };

/** The hint's "PUSH … " for a lobby seat standing at a door, or `null` anywhere else. A string, so a selector returning it is stable. */
export function pushWay(zone: number, x: number, y: number): string | null {
  if (zone !== ZONE_LOBBY) return null;
  for (const room of SIDE_ROOMS) {
    if (inBlock(room.door, x, y)) return `${WORD[room.knock] ?? ''} ${room.name === 'range' ? 'down the stairs' : 'into the door'}`;
  }
  return null;
}

/** The hint's "WALK … to leave" for a seat in `zone`, or `null` outside every room. A string, so a selector returning it is stable. */
export function leaveWay(zone: number): string | null {
  const room = sideRoomOf(zone);
  if (room === null) return null;
  return `${WORD[room.leave] ?? ''} ${room.name === 'range' ? 'up the stairs' : 'through the door'}`;
}

// ---------------------------------------------------------------------------
// The range: where an arrow stops inside a room
// ---------------------------------------------------------------------------

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Where a room's geometry stops an arrow, and the straw man it struck, if any. */
export interface RoomRay {
  readonly end: Point;
  readonly dummy: number | null;
}

/** The straw men's rects, in world units — the sprites' boxes are their hitboxes. */
export function rangeTargets(art: SideRoomArt): WorldRect[] {
  return Object.keys(art.anchors)
    .filter((k) => k.startsWith('dummy'))
    .sort()
    .map((k) => art.anchors[k]!);
}

/** The ray's entry and exit distances through a rect; the slab test, both axes. */
function slab(r: WorldRect, x: number, y: number, ux: number, uy: number): [number, number] {
  const span = (lo: number, hi: number, o: number, u: number): [number, number] => {
    if (u === 0) return o >= lo && o <= hi ? [-Infinity, Infinity] : [Infinity, -Infinity];
    const a = (lo - o) / u;
    const b = (hi - o) / u;
    return a < b ? [a, b] : [b, a];
  };
  const [x0, x1] = span(r.x, r.x + r.w, x, ux);
  const [y0, y1] = span(r.y, r.y + r.h, y, uy);
  return [Math.max(x0, y0), Math.min(x1, y1)];
}

/**
 * A shot from (`x`, `y`) along (`dx`, `dy`) by a seat in `zone`, whose ray the grid would
 * end at `end`: cut to the room's floor (its walls are the painting's, not the grid's) and,
 * in the range, to the first straw man it crosses. `null` outside every room. Client
 * geometry over an on-chain shot — the same standing the boss raycast has in the pit.
 */
export function roomRay(zone: number, x: number, y: number, dx: number, dy: number, end: Point): RoomRay | null {
  const room = sideRoomOf(zone);
  if (room === null) return null;
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  const ux = dx / len;
  const uy = dy / len;
  const art = artOf(room);
  let t = Math.min(Math.hypot(end.x - x, end.y - y), Math.max(slab(art.floor, x, y, ux, uy)[1], 0));
  let dummy: number | null = null;
  rangeTargets(art).forEach((r, i) => {
    const [enter, exit] = slab(r, x, y, ux, uy);
    if (enter <= exit && exit >= 0 && Math.max(enter, 0) < t) {
      t = Math.max(enter, 0);
      dummy = i;
    }
  });
  return { end: { x: x + ux * t, y: y + uy * t }, dummy };
}

/**
 * The straw man to loose at from (`x`, `y`) for a seat in `zone`: the nearest by its centre,
 * as the wire's `i8` pair, or `null` outside the range. `App.tsx`'s aim asks after the boss
 * and before the seat's own facing, the way `autoAim` picks the creature.
 */
export function rangeAim(zone: number, x: number, y: number): readonly [number, number] | null {
  const room = sideRoomOf(zone);
  if (room === null) return null;
  let best: WorldRect | null = null;
  let bestD = Infinity;
  for (const r of rangeTargets(artOf(room))) {
    const d = (r.x + r.w / 2 - x) ** 2 + (r.y + r.h / 2 - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best === null ? null : aimFromVector(best.x + best.w / 2 - x, best.y + best.h / 2 - y);
}

/** The range's ear: `Shot.tsx` calls it when an arrow lands on straw man `i`. */
let struck: ((i: number) => void) | null = null;
export function dummyStruck(i: number): void {
  struck?.(i);
}

/** `41,250` under five digits, `41.3k` above: the tablets are narrow. */
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

function Range({ art }: { art: SideRoomArt }) {
  const targets = rangeTargets(art);
  const [tally, setTally] = useState<number[]>(() => targets.map(() => 0));
  const nodes = useRef<(SVGGElement | null)[]>([]);
  useEffect(() => {
    struck = (i) => {
      const el = nodes.current[i];
      if (el) {
        // Restart the flinch on a straw man already flinching: drop the class, flush, add it.
        el.classList.remove('is-hit');
        void el.getBoundingClientRect();
        el.classList.add('is-hit');
      }
      setTally((n) => n.map((v, k) => (k === i ? v + 1 : v)));
    };
    return () => {
      struck = null;
    };
  }, []);
  return (
    <>
      {targets.map((r, i) => (
        <g key={i}>
          <g
            ref={(el) => {
              nodes.current[i] = el;
            }}
            className="range-dummy"
          >
            <use href="#range-dummy" x={r.x} y={r.y} width={r.w} height={r.h} />
          </g>
          {(tally[i] ?? 0) > 0 && (
            <text className="room-text is-you" x={r.x + r.w / 2} y={r.y - 4} textAnchor="middle">
              {`\u00d7${tally[i]}`}
            </text>
          )}
        </g>
      ))}
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
      {room.name === 'range' && <Range art={art} />}
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
  // The range's geometry: an arrow from the west end flies to the first straw man in its
  // path and no further; one aimed along the back wall stops at the east wall; outside a
  // room the ray is untouched.
  const range = SIDE_ROOMS.find((r) => r.name === 'range');
  if (range !== undefined) {
    const art = artOf(range);
    const targets = rangeTargets(art);
    if (targets.length < 3) fail('the range has fewer than three straw men');
    const t0 = targets[0]!;
    const zone = ZONE_LOBBY + 2 + SIDE_ROOMS.indexOf(range);
    const from = { x: art.floor.x + 8, y: t0.y + t0.h / 2 };
    const shot = roomRay(zone, from.x, from.y, 1, 0, { x: from.x + 2000, y: from.y });
    if (shot === null || shot.dummy !== 0 || Math.abs(shot.end.x - t0.x) > 0.01) fail('a level arrow does not stop on the first straw man');
    const wall = roomRay(zone, from.x, art.floor.y + 4, 1, 0, { x: from.x + 2000, y: art.floor.y + 4 });
    if (wall === null || wall.dummy !== null || Math.abs(wall.end.x - (art.floor.x + art.floor.w)) > 0.01) fail('an arrow along the back wall does not stop at the east wall');
    if (roomRay(ZONE_LOBBY, from.x, from.y, 1, 0, { x: 0, y: 0 }) !== null) fail('a lobby shot is cut by a room');
    // The aim finds the nearest straw man on its own: from the firing line, level with the
    // first, it points east and slightly at him; from the lobby it points at nothing.
    const aim = rangeAim(zone, from.x, from.y);
    if (aim === null || aim[0] <= 0 || Math.abs(aim[1]) > Math.abs(aim[0])) fail('the range does not aim at its straw');
    if (rangeAim(ZONE_LOBBY, from.x, from.y) !== null) fail('the lobby aims at straw');
  }
}
