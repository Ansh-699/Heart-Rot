/**
 * PERF-CHOPPY — frame-level proof that the local knight stopped stuttering in a fight.
 *
 * The bug: "works great but when the boss activates movement becomes choppy". The cause,
 * established in `docs/perf/choppy-feed.md`, is not latency — it is that the local seat
 * was drawn from `useSeatInterpolation`, which lerps between *authoritative* snapshots,
 * while `boss_tick` rewrites `Players` every 100 ms with no position change in it. The
 * lerp then runs P→P for a window and jumps when a real move finally lands.
 *
 * This script does not go near the network. It replays one synthetic feed — the shape the
 * fight actually delivers — through the positioning logic and records where the local seat
 * would be drawn on every 16.7 ms frame. Two arms are the shipped code (`createPredictor`
 * from `app/src/net/predict.ts`, `chase`/`MOVE_MS` from `app/src/render/Arena.tsx`); one
 * is the pre-fix rule, reconstructed — see `beforeTrack`.
 *
 * The feed, per the measured facts:
 *   - one `move` every 50 ms (`input/controls.ts` `MOVE_MS`, the chain's own floor),
 *   - its authoritative echo 127 ms later (write-to-visible p50, `docs/perf/RESULT.md`),
 *   - a crank snapshot every 100 ms (`state::TICK_MS`) carrying the position already
 *     published — position-preserving by construction, which is the whole defect.
 *
 * Run:
 *   ./app/node_modules/.bin/esbuild \
 *     scripts/spike/perf_choppy.ts --bundle --platform=node --format=esm \
 *     --jsx=automatic --define:import.meta.env.DEV=true --outfile=/tmp/perf_choppy.mjs
 *   node /tmp/perf_choppy.mjs            # LEG=<n> to vary how often the walk reverses
 *
 * `import.meta.env.DEV=true` is deliberate: it makes the imported modules run their own
 * dev self-checks on load, so a broken predictor throws here rather than being measured.
 */

import { MAP_TILE, type PlayerSlot } from '@heartrot/client';

import { createPredictor } from '../../app/src/net/predict';
import { chase, MOVE_MS } from '../../app/src/render/Arena';

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

const FRAME_MS = 1000 / 60;
/** Crank period — `state::TICK_MS`. */
const TICK_MS = 100;
/** Write-to-visible p50, measured on devnet: `docs/perf/RESULT.md`. */
const RTT_MS = 127;
const DURATION_MS = 20_000;
/** Tile row 4 is open floor for its whole width in the generated dungeon. */
const FREE_Y = 4 * MAP_TILE;
/**
 * East for `LEG` inputs, west for `LEG`, so a 20 s walk stays on the free row. Overridable
 * so the cost of a direction reversal can be separated from the cost of walking: reversals
 * scale with `1 / LEG` and nothing else in the run does.
 */
const LEG = Number(process.env.LEG ?? 30);

type Point = { x: number; y: number };

interface Snapshot {
  readonly at: number;
  readonly slot: PlayerSlot;
}

const slotAt = (x: number, facing: number, lastMoveSeq: number): PlayerSlot =>
  ({
    seat: 0,
    occupied: true,
    zone: 1,
    facing,
    skinId: 0,
    x,
    y: FREE_Y,
    hp: 100,
    hpMax: 100,
    lastMoveSeq,
  }) as unknown as PlayerSlot;

/**
 * The input the player produces and the snapshot stream the client gets back.
 *
 * `double` reproduces the Magic Router's measured habit of delivering every notification
 * twice, byte-identical, ~1 ms apart (`docs/perf/choppy-feed.md`).
 */
function feed(double: boolean): { inputs: { at: number; dir: number }[]; snaps: Snapshot[] } {
  const inputs: { at: number; dir: number }[] = [];
  const moves: Snapshot[] = [];
  let x = 320;
  let seq = 0;
  for (let t = 0, i = 0; t < DURATION_MS; t += MOVE_MS, i++) {
    const dir = Math.floor(i / LEG) % 2 === 0 ? 2 : 6;
    inputs.push({ at: t, dir });
    x += dir === 2 ? MAP_TILE : -MAP_TILE;
    seq = (seq + 1) & 0xffff;
    moves.push({ at: t + RTT_MS, slot: slotAt(x, dir, seq) });
  }

  const snaps: Snapshot[] = [];
  let m = 0;
  let published = slotAt(320, 2, 0);
  for (let t = 0; t < DURATION_MS + RTT_MS; t += 1) {
    while (m < moves.length && moves[m]!.at === t) {
      published = moves[m]!.slot;
      snaps.push(moves[m]!);
      m++;
    }
    // The crank rewrites `Players` for collisions and respawns; the seat did not move, so
    // the bytes it publishes for this seat are the ones already out there.
    if (t > 0 && t % TICK_MS === 0) snaps.push({ at: t, slot: published });
  }
  snaps.sort((a, b) => a.at - b.at);
  if (!double) return { inputs, snaps };
  const twinned: Snapshot[] = [];
  for (const s of snaps) {
    twinned.push(s);
    twinned.push({ at: s.at + 1, slot: s.slot });
  }
  return { inputs, snaps: twinned };
}

// ---------------------------------------------------------------------------
// The pre-fix rule, reconstructed
//
// The shipping code no longer contains it, so it is rebuilt here from the rule as it was
// recorded while it was live — `docs/perf/choppy-feed.md` § Method: "`previous <- next`
// and a re-anchor on every notification, position `lerp(previous, next, clamp((now - at)
// / 100))`, snapping when the pair looks like a teleport." One global anchor, shared by
// every seat, re-armed by any `Players` write whether or not it moved anybody.
// ---------------------------------------------------------------------------

function beforeTrack() {
  let previous = slotAt(320, 2, 0);
  let next = previous;
  let at = 0;
  return {
    push(slot: PlayerSlot, now: number): void {
      previous = next;
      next = slot;
      at = now;
      if (Math.abs(next.x - previous.x) > 4 * MAP_TILE) previous = next;
    },
    at(now: number, out: Point): void {
      const alpha = Math.min(1, Math.max(0, (now - at) / TICK_MS));
      out.x = previous.x + (next.x - previous.x) * alpha;
      out.y = previous.y + (next.y - previous.y) * alpha;
    },
  };
}

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

/** Where the local seat is drawn on each 16.7 ms frame, for one arm. */
type Arm = (f: ReturnType<typeof feed>) => Point[];

const runFrames = (
  f: ReturnType<typeof feed>,
  onInput: (dir: number, now: number) => void,
  onSnap: (s: Snapshot, now: number) => void,
  draw: (now: number, dt: number, out: Point) => void,
): Point[] => {
  const frames: Point[] = [];
  let i = 0;
  let s = 0;
  let last = 0;
  for (let n = 0; n * FRAME_MS < DURATION_MS + RTT_MS; n++) {
    const now = n * FRAME_MS;
    while (i < f.inputs.length && f.inputs[i]!.at <= now) onInput(f.inputs[i]!.dir, f.inputs[i++]!.at);
    while (s < f.snaps.length && f.snaps[s]!.at <= now) onSnap(f.snaps[s]!, f.snaps[s++]!.at);
    const out = { x: 0, y: 0 };
    draw(now, now - last, out);
    last = now;
    frames.push(out);
  }
  return frames;
};

/** BEFORE — the local seat drawn from the pre-fix global interpolator. */
const before: Arm = (f) => {
  const track = beforeTrack();
  return runFrames(
    f,
    () => {},
    (s, now) => track.push(s.slot, now),
    (now, _dt, out) => track.at(now, out),
  );
};

/** RAW PREDICTION — `predictor.self` drawn straight, no chase. The 20 Hz staircase. */
const raw: Arm = (f) => {
  const p = createPredictor();
  return runFrames(
    f,
    (dir, now) => void p.push(dir, now),
    (s, now) => p.reconcile(s.slot, now),
    (_now, _dt, out) => {
      out.x = p.self.x;
      out.y = p.self.y;
    },
  );
};

/** AFTER — the shipped renderer: prediction chased at `MAP_TILE` per input period. */
const after: Arm = (f) => {
  const p = createPredictor();
  const drawn: Point = { x: 320, y: FREE_Y };
  return runFrames(
    f,
    (dir, now) => void p.push(dir, now),
    (s, now) => p.reconcile(s.slot, now),
    (_now, dt, out) => {
      chase(drawn, p.self, (MAP_TILE * Math.min(MOVE_MS, dt)) / MOVE_MS);
      out.x = drawn.x;
      out.y = drawn.y;
    },
  );
};

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/** Below this a frame drew the seat where the previous frame did. Sub-pixel at any zoom. */
const STATIC_EPS = 0.01;

interface Stats {
  frames: number;
  staticFrames: number;
  staticPct: number;
  longestStaticRun: number;
  maxJump: number;
  mean: number;
  stdDev: number;
}

function stats(frames: Point[], skip: number): Stats {
  const d: number[] = [];
  for (let i = skip + 1; i < frames.length; i++) {
    const a = frames[i - 1]!;
    const b = frames[i]!;
    d.push(Math.hypot(b.x - a.x, b.y - a.y));
  }
  const mean = d.reduce((s, v) => s + v, 0) / d.length;
  const variance = d.reduce((s, v) => s + (v - mean) ** 2, 0) / d.length;
  let staticFrames = 0;
  let run = 0;
  let longest = 0;
  for (const v of d) {
    if (v < STATIC_EPS) {
      staticFrames++;
      run++;
      if (run > longest) longest = run;
    } else run = 0;
  }
  return {
    frames: d.length,
    staticFrames,
    staticPct: (100 * staticFrames) / d.length,
    longestStaticRun: longest,
    maxJump: Math.max(...d),
    mean,
    stdDev: Math.sqrt(variance),
  };
}

// ---------------------------------------------------------------------------

const main = (): void => {
  // Frames before the first authoritative snapshot land while nothing has been published
  // yet; they belong to no arm's behaviour. One RTT of warm-up is dropped from all four.
  const skip = Math.ceil(RTT_MS / FRAME_MS);
  const out: Record<string, Record<string, Stats>> = {};
  for (const double of [false, true]) {
    const f = feed(double);
    const key = double ? 'router-doubled' : 'clean';
    out[key] = {
      before: stats(before(f), skip),
      rawPrediction: stats(raw(f), skip),
      after: stats(after(f), skip),
    };
  }
  // The ideal: one tile per 50 ms input period, evenly spread over 16.7 ms frames.
  const ideal = (MAP_TILE * FRAME_MS) / MOVE_MS;
  console.log(
    JSON.stringify(
      {
        idealPerFrame: ideal,
        frameMs: FRAME_MS,
        rttMs: RTT_MS,
        tickMs: TICK_MS,
        leg: LEG,
        reversals: Math.floor(DURATION_MS / MOVE_MS / LEG),
        arms: out,
      },
      null,
      2,
    ),
  );
};

main();
