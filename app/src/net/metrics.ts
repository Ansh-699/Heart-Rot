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
  /** Observed arena ticks per second. The chain targets 2.5 (400 ms). */
  readonly tickHz: number | null;
  /** Sends still waiting on an acknowledgement. */
  readonly pending: number;
  /** Share of sends that were never acknowledged, over the window. 0–1. */
  readonly dropRate: number;
  /** Milliseconds since the last account update arrived. `null` before the first. */
  readonly feedAge: number | null;
  /** Total submitted this session. */
  readonly txTotal: number;
}

const sendTimes: number[] = [];
const ackTimes: number[] = [];
const dropTimes: number[] = [];
const latencies: number[] = [];
const ticks: Array<{ t: number; tick: number }> = [];
/** seq -> the moment it was submitted. */
const pending = new Map<number, number>();

let txTotal = 0;
let lastFeedAt: number | null = null;
let listeners: Array<() => void> = [];

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

/**
 * A gameplay transaction left the browser. `seq` is present for `move` only — `shoot`
 * carries no sequence number, so it counts toward throughput but never toward latency.
 */
export function recordSend(seq?: number): void {
  const now = Date.now();
  txTotal += 1;
  sendTimes.push(now);
  trim(sendTimes, now);
  if (seq !== undefined) pending.set(seq, now);
  emit();
}

/**
 * An account update arrived. `lastSeq` acknowledges every move up to and including it,
 * so one update can resolve several sends — which is exactly what happens when the
 * client is ahead of the 400 ms tick.
 */
export function recordWorld(tick?: number, lastSeq?: number): void {
  const now = Date.now();
  lastFeedAt = now;

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
      if (seq > lastSeq) continue;
      pending.delete(seq);
      latencies.push(now - at);
      if (latencies.length > SAMPLES) latencies.shift();
      ackTimes.push(now);
    }
    trim(ackTimes, now);
  }

  // Anything still outstanding past the deadline was refused or lost. Because sends are
  // fire-and-forget this is the only evidence either way, so it is reported as "dropped"
  // and never as a specific on-chain error.
  for (const [seq, at] of pending) {
    if (now - at <= DROP_AFTER_MS) continue;
    pending.delete(seq);
    dropTimes.push(now);
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

  const sorted = [...latencies].sort((a, b) => a - b);
  const acked = ackTimes.length;
  const dropped = dropTimes.length;
  const settled = acked + dropped;

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
    feedAge: lastFeedAt === null ? null : now - lastFeedAt,
    txTotal,
  };
}

/** Subscribe to every recorded event. Returns the unsubscribe. */
export function onMetrics(fn: () => void): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((f) => f !== fn);
  };
}

/** Drop every sample. Used when a match ends so the next one starts clean. */
export function resetMetrics(): void {
  sendTimes.length = 0;
  ackTimes.length = 0;
  dropTimes.length = 0;
  latencies.length = 0;
  ticks.length = 0;
  pending.clear();
  txTotal = 0;
  lastFeedAt = null;
  emit();
}
