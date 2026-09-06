/**
 * Client telemetry. Every number here is measured; none is estimated.
 *
 * Two facts about this game's hot path decide what can be measured at all:
 *
 * 1. Gameplay is sent with `skipPreflight` and never confirmed, so a refused instruction
 *    returns a signature and quietly does nothing. `Custom(7)` RateLimited and
 *    `Custom(8)` PlayerDead are invisible out here. There is no honest "rejected"
 *    counter to keep, so this module does not pretend to have one.
 * 2. `move` carries a `seq` and the roster returns `last_seq`. A send can therefore be
 *    matched to the update that acknowledges it, and that round trip is write-to-visible
 *    latency — the number the whole design is built on. Devnet measured p50 200 ms at 20
 *    concurrent seats against 405 ms for a single player, because `move` takes Arena
 *    read-only and concurrent movers never serialise.
 *
 * So latency comes from seq acknowledgement, and a send whose seq never lands inside
 * `DROP_AFTER_MS` is counted as dropped. That is a proxy for rejection and the UI labels
 * it as one rather than dressing it up as a chain-reported error.
 *
 * **Only the exact seq is a latency sample.** `last_move_seq` is a high-water mark, so an
 * update carrying seq M settles every earlier send too — but a send the chain *refused*
 * never echoes its own seq, and charging it with the wait for a later write reports a
 * round trip nobody made. The client sends one move per 50 ms ER slot and `move_player`
 * refuses a second move in the same slot (`slot.last_move_tick == now -> RateLimited`),
 * so at this cadence refusals are ordinary traffic, not an error condition. They are
 * counted separately as `refusedRate` and kept out of the percentiles entirely.
 *
 * No dependencies, fixed-size buffers, no allocation per frame: this runs beside a 60 fps
 * renderer and must never be the reason a frame is late.
 */

/** Sliding window every rate is computed over. Long enough to be stable at 2.5 ticks/s. */
const WINDOW_MS = 5_000;

/** A move whose `seq` has not been acknowledged by now is treated as dropped. */
const DROP_AFTER_MS = 3_000;

/** Latency samples retained for the percentiles. ~2 minutes of play at one move a tick. */
const SAMPLES = 240;

export interface Snapshot {
  /** Transactions submitted per second, over the window. */
  readonly txPerSec: number;
  /** Acknowledged writes per second — sends whose `seq` came back. */
  readonly ackPerSec: number;
  /** Write-to-visible milliseconds. `null` until a move has been acknowledged. */
  readonly p50: number | null;
  readonly p95: number | null;
  readonly last: number | null;
  /** Observed arena ticks per second. The chain targets 10 (`TICK_MS` 100). */
  readonly tickHz: number | null;
  /** Sends still waiting on an acknowledgement. */
  readonly pending: number;
  /** Share of sends that were never acknowledged, over the window. 0–1. */
  readonly dropRate: number;
  /**
   * Share of moves the chain superseded — a later seq came back first, so this one was
   * refused (one move per ER slot) or lost. Over the window, 0–1. Ordinary traffic at a
   * 50 ms send cadence; it is a rejection rate, not a fault.
   */
  readonly refusedRate: number;
  /** Milliseconds since the last account update arrived. `null` before the first. */
  readonly feedAge: number | null;
  /** Total submitted this session. */
  readonly txTotal: number;
  /**
   * The arena's own traffic, as evidence: every raider's `move` (a `lastMoveSeq` step on
   * any seat), every `shoot` (a `lastShotTick` change on any seat) and every crank tick
   * (an `Arena.tick` step), counted off the feed. Per second over the window, and the
   * session total. Each one is one transaction the chain executed; none is estimated.
   */
  readonly movesPerSec: number;
  readonly shotsPerSec: number;
  readonly ticksPerSec: number;
  readonly writesPerSec: number;
  readonly writesTotal: number;
  /** The newest of this tab's own transactions, newest first. */
  readonly recent: readonly TxRecord[];
}

/** What this tab sent: what, when, its signature once the node answered, and how it ended. */
export interface TxRecord {
  readonly id: number;
  readonly kind: 'move' | 'shoot' | 'gate';
  readonly seq?: number;
  readonly signature?: string;
  readonly at: number;
  readonly state: 'sent' | 'acked' | 'refused' | 'dropped';
  /** Write-to-visible, once acknowledged. */
  readonly ms?: number;
}

/** How many of this tab's transactions the panel lists. */
const RECENT = 10;

const sendTimes: number[] = [];
const ackTimes: number[] = [];
const dropTimes: number[] = [];
const refusedTimes: number[] = [];
const latencies: number[] = [];
const ticks: Array<{ t: number; tick: number }> = [];
/** seq -> the moment it was submitted. */
const pending = new Map<number, number>();

let txTotal = 0;
let lastFeedAt: number | null = null;
let listeners: Array<() => void> = [];

let nextId = 1;
let recent: TxRecord[] = [];
const moveTimes: number[] = [];
const shotTimes: number[] = [];
const tickTimes: number[] = [];
let writesTotal = 0;
/** Per seat, the last `lastMoveSeq` / `lastShotTick` seen, for the diff that counts writes. */
let seenSeq: number[] = [];
let seenShot: number[] = [];
let seenTick: number | null = null;
let ownShot: number | null = null;

function note(id: number, patch: Partial<TxRecord>): void {
  recent = recent.map((r) => (r.id === id ? { ...r, ...patch } : r));
}

function trim(buf: number[], now: number): void {
  for (;;) {
    const head = buf[0];
    if (head === undefined || now - head <= WINDOW_MS) return;
    buf.shift();
  }
}

function emit(): void {
  for (const fn of listeners) fn();
}

/** `seq` is at or behind the acknowledged high-water mark, across the u16 wrap. */
function isSettled(lastSeq: number, seq: number): boolean {
  return ((lastSeq - seq) & 0xffff) < 0x8000;
}

/**
 * A gameplay transaction left the browser. `seq` is present for `move` only — `shoot`
 * carries no sequence number, so it counts toward throughput but never toward latency.
 */
export function recordSend(seq?: number, kind: TxRecord['kind'] = seq === undefined ? 'shoot' : 'move'): number {
  const now = Date.now();
  txTotal += 1;
  sendTimes.push(now);
  trim(sendTimes, now);
  if (seq !== undefined) pending.set(seq, now);
  const id = nextId++;
  const rec: TxRecord = { id, kind, seq, at: now, state: 'sent' };
  recent = [rec, ...recent].slice(0, RECENT);
  emit();
  return id;
}

/** The node answered a send with its signature. */
export function recordSignature(id: number, signature: string): void {
  note(id, { signature });
  emit();
}

/**
 * The arena's traffic, read off one account update: which seats moved, which shot, and
 * whether the crank ticked. Called with every decoded update, so a seat's step from seq N
 * to N+3 counts three moves (wrap-safe, capped so a rejoin's jump is not a burst).
 */
export function recordWrites(tick: number | undefined, slots: ReadonlyArray<{ readonly occupied: boolean; readonly lastMoveSeq: number; readonly lastShotTick: number }> | undefined): void {
  const now = Date.now();
  if (tick !== undefined) {
    if (seenTick !== null && tick > seenTick) {
      const n = Math.min(tick - seenTick, 5);
      for (let i = 0; i < n; i++) tickTimes.push(now);
      writesTotal += n;
    }
    seenTick = tick;
  }
  if (slots !== undefined) {
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!;
      if (!slot.occupied) {
        seenSeq[i] = -1;
        seenShot[i] = -1;
        continue;
      }
      const ps = seenSeq[i];
      if (ps !== undefined && ps >= 0) {
        const d = (slot.lastMoveSeq - ps) & 0xffff;
        if (d > 0 && d < 0x8000) {
          const n = Math.min(d, 8);
          for (let k = 0; k < n; k++) moveTimes.push(now);
          writesTotal += n;
        }
      }
      seenSeq[i] = slot.lastMoveSeq;
      const pt = seenShot[i];
      if (pt !== undefined && pt >= 0 && slot.lastShotTick !== pt) {
        shotTimes.push(now);
        writesTotal += 1;
      }
      seenShot[i] = slot.lastShotTick;
    }
  }
  trim(moveTimes, now);
  trim(shotTimes, now);
  trim(tickTimes, now);
}

/**
 * An account update arrived. `lastSeq` acknowledges every move up to and including it,
 * so one update can resolve several sends — which is exactly what happens when the
 * client is ahead of the 100 ms tick.
 */
export function recordWorld(tick?: number, lastSeq?: number, lastShotTick?: number): void {
  const now = Date.now();
  lastFeedAt = now;

  // A shot carries no seq, so its acknowledgement is the seat's own `lastShotTick`
  // moving: the oldest shot still marked sent is the one it answers.
  if (lastShotTick !== undefined && lastShotTick !== ownShot) {
    if (ownShot !== null) {
      const r = [...recent].reverse().find((x) => x.kind === 'shoot' && x.state === 'sent');
      if (r) note(r.id, { state: 'acked', ms: now - r.at });
    }
    ownShot = lastShotTick;
  }

  if (tick !== undefined) {
    const prev = ticks[ticks.length - 1];
    if (!prev || prev.tick !== tick) ticks.push({ t: now, tick });
    for (;;) {
      const head = ticks[0];
      if (head === undefined || now - head.t <= WINDOW_MS) break;
      ticks.shift();
    }
  }

  if (lastSeq !== undefined) {
    for (const [seq, at] of pending) {
      // Wrap-safe, same test `predict.ts` reconciles with: `seq` is a u16 and a plain `>`
      // inverts once every 65,536 moves — 55 minutes at this cadence, which is inside a
      // long match.
      if (!isSettled(lastSeq, seq)) continue;
      pending.delete(seq);
      const rec = recent.find((x) => x.seq === seq && x.kind === 'move');
      if (seq === lastSeq) {
        latencies.push(now - at);
        if (latencies.length > SAMPLES) latencies.shift();
        ackTimes.push(now);
        if (rec) note(rec.id, { state: 'acked', ms: now - at });
      } else {
        // Superseded: this seq never came back on its own, so there is no round trip to
        // record. Timing it against a later write would report a number nothing measured.
        refusedTimes.push(now);
        if (rec) note(rec.id, { state: 'refused' });
      }
    }
    trim(ackTimes, now);
    trim(refusedTimes, now);
  }

  // Anything still outstanding past the deadline was refused or lost. Because sends are
  // fire-and-forget this is the only evidence either way, so it is reported as "dropped"
  // and never as a specific on-chain error.
  for (const [seq, at] of pending) {
    if (now - at <= DROP_AFTER_MS) continue;
    pending.delete(seq);
    dropTimes.push(now);
    const rec = recent.find((x) => x.seq === seq && x.kind === 'move');
    if (rec) note(rec.id, { state: 'dropped' });
  }
  trim(dropTimes, now);
  emit();
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] ?? null;
}

export function snapshot(): Snapshot {
  const now = Date.now();
  trim(sendTimes, now);
  trim(ackTimes, now);
  trim(dropTimes, now);
  trim(refusedTimes, now);
  trim(moveTimes, now);
  trim(shotTimes, now);
  trim(tickTimes, now);

  const sorted = [...latencies].sort((a, b) => a - b);
  const acked = ackTimes.length;
  const dropped = dropTimes.length;
  const refused = refusedTimes.length;
  const settled = acked + dropped + refused;

  // Tick rate needs two observations at different times, or the divisor is zero.
  const first = ticks[0];
  const last = ticks[ticks.length - 1];
  const span = first && last ? last.t - first.t : 0;
  const tickHz = first && last && span > 500 ? ((last.tick - first.tick) / span) * 1000 : null;

  return {
    txPerSec: sendTimes.length / (WINDOW_MS / 1000),
    ackPerSec: acked / (WINDOW_MS / 1000),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    last: latencies[latencies.length - 1] ?? null,
    tickHz,
    pending: pending.size,
    dropRate: settled > 0 ? dropped / settled : 0,
    refusedRate: settled > 0 ? refused / settled : 0,
    feedAge: lastFeedAt === null ? null : now - lastFeedAt,
    txTotal,
    movesPerSec: moveTimes.length / (WINDOW_MS / 1000),
    shotsPerSec: shotTimes.length / (WINDOW_MS / 1000),
    ticksPerSec: tickTimes.length / (WINDOW_MS / 1000),
    writesPerSec: (moveTimes.length + shotTimes.length + tickTimes.length) / (WINDOW_MS / 1000),
    writesTotal,
    recent,
  };
}

/** Subscribe to every recorded event. Returns the unsubscribe. */
export function onMetrics(fn: () => void): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((f) => f !== fn);
  };
}

// ---------------------------------------------------------------------------
// Self-check. Both failures here are quiet and both inflate the headline number: charging
// a refused move with the wait for a later one overstates p50 by roughly a round trip, and
// a non-wrap-safe seq compare stops acknowledging anything at all after 65,536 moves.
// Dev-only, and it resets what it recorded.
// ---------------------------------------------------------------------------

if (import.meta.env.DEV) {
  const assert = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(`metrics self-check: ${what}`);
  };

  recordSend(7);
  recordSend(8);
  recordWorld(1, 8);
  const m = snapshot();
  assert(m.pending === 0, 'both moves must settle');
  assert(m.refusedRate === 0.5, 'the superseded seq must be counted as refused, not acknowledged');
  assert(latencies.length === 1, 'only the seq that came back is a latency sample');

  resetMetrics();
  recordSend(0xfffe);
  recordWorld(1, 1); // seq wrapped past 0xffff
  assert(snapshot().pending === 0, 'a seq before the u16 wrap must still settle');

  resetMetrics();
}

/** Drop every sample. Used when a match ends so the next one starts clean. */
export function resetMetrics(): void {
  sendTimes.length = 0;
  ackTimes.length = 0;
  dropTimes.length = 0;
  refusedTimes.length = 0;
  latencies.length = 0;
  ticks.length = 0;
  pending.clear();
  txTotal = 0;
  lastFeedAt = null;
  emit();
}
