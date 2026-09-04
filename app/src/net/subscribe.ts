/**
 * The live state feed: one WebSocket, three accounts, and a watchdog on the only
 * liveness signal that exists.
 *
 * Everything below is empirical — **zero of MagicBlock's 215 documentation pages mention
 * `Subscribe`** — and each rule is here because breaking it fails silently rather than
 * loudly (`realtime-sync.md`, `01-architecture.md` §6.2):
 *
 * - **The pinned ER's WS, not the router's.** The old note here claimed the router cost a
 *   p50 of −4 ms over 488 matched slots. It does not reproduce. Raced properly — both
 *   sockets open at once on the same six oracle-written accounts, so every sample is one
 *   identical write observed twice and the submit half cancels — the router is **+26.8 ms
 *   p50** (p10 +20.3, p90 +33.0, ER first on 96% of 2,361 paired writes).
 *
 *   The cause is not a proxy hop, and this is the part that decides the whole question:
 *   the router is behind Cloudflare, whose IPv6 anycast is ~163 ms further from this ISP
 *   than its IPv4 edge (TCP connect p50 190.5 vs 27.4 ms), while the ER is identical on
 *   both families (118.6 vs 120.9) because its AAAA is a DNS64-synthesised `64:ff9b::`
 *   address taking the same path as its A. Resolve the router IPv4-first and it is a few
 *   ms *faster* than the ER; resolve verbatim and it is 27 ms slower. The OS resolver here
 *   returns the AAAA first, so a browser reaches the router over the slow family — which
 *   is why this is worth changing and why the number is a property of the player's network,
 *   not of the router.
 *
 *   The fqdn is never guessed: it is the one the *router itself* published for the
 *   identity the already-pinned `rpc` reports, so both halves of this file talk to exactly
 *   one ER, resolved through the same chain `connectMatch` used. If that resolution fails,
 *   or the identity is not in the routes table, this falls back to the router — which is
 *   never the *wrong* ER (it resolves the delegation record per account), only a slower
 *   one. `wsUrl` still overrides everything, and is never re-resolved.
 *
 *   The router supports **only** `accountSubscribe` and `signatureSubscribe`;
 *   `programSubscribe`, `logsSubscribe` and `slotSubscribe` are all `-32601`, so a client
 *   that assumes pubsub parity gets nothing and no error. The ER serves all of them.
 *
 *   What is given up: the router follows a mid-match re-delegation to another validator
 *   and a pinned socket does not. The snapshot was already pinned to `rpc`, so that half
 *   never followed one either — this makes the two agree instead of letting them describe
 *   different worlds. The tick watchdog below is the backstop.
 * - **`encoding: 'base64'` explicitly.** The ER's default is base58.
 * - **Commitment is ignored.** `processed`, `confirmed` and `finalized` returned the same
 *   subscription id — one validator, no consensus. It is not passed here at all rather
 *   than passed and silently meaningless.
 * - **Snapshot on every `open`.** Subscribing delivers nothing until the next *write*; a
 *   delegated but idle account produced 0 notifications in 20 s. Without the snapshot a
 *   player who stands still after a reconnect sees a stale world forever. This is the
 *   single most load-bearing line in the file.
 * - **Own the socket.** web3.js reconnects on a fixed 1,000 ms interval with no backoff
 *   and no jitter, so one ER blip retries twenty clients in lockstep, and it re-sends a
 *   *failed* subscribe with zero delay in a recursive hot loop. Backoff here is
 *   exponential and jittered.
 * - **Keep this subscription alive across the lobby↔arena transition.** Measured
 *   reconnect outage is 1,681 ms — four missed crank ticks, and in a bullet-hell fight
 *   that is a death and a visible teleport.
 *
 * Only three accounts are subscribed (D3: `Arena`, `Boss`, `Players`), not the 21 that
 * `01-architecture.md` §6.2 still says — the layout contract packs all twenty seats into
 * one account. Nothing static is subscribed at all.
 */

import {
  PHASE_FIGHTING,
  PHASE_MUSTERING,
  decodeArena,
  decodeBoss,
  decodePlayers,
  type ArenaAccount,
  type BossAccount,
  type HeartrotRpc,
  type PlayersAccount,
} from '@heartrot/client';

/**
 * `Address` without importing `@solana/kit`: `app/package.json` does not depend on it
 * directly, and under pnpm's non-hoisted layout a bare import would not resolve here.
 */
type AccountAddress = Parameters<HeartrotRpc['getAccountInfo']>[0];

/** The Magic Router's WebSocket. Same host as `ROUTER_ENDPOINT`, `wss` scheme. */
/** Frames further than this from the snapshot's slot are another chain's: ~5.8 days of rollup slots. */
const SLOT_DOMAIN = 10_000_000;

export const ROUTER_WS_ENDPOINT = 'wss://devnet-router.magicblock.app/';

/**
 * Soft stall: about seven missed crank ticks. Could be a socket stall, a wrong-ER
 * subscription, or the crank's retry ladder in progress. Resnapshot and warn — **do not
 * settle**, because a single 3 s trigger settles matches that were about to recover.
 */
export const TICK_STALL_SOFT_MS = 3_000;

/**
 * Hard stall: the task is dead and the caller should `POST /api/match/settle`.
 *
 * 45 s, not the 30 s in `01-architecture.md` §4.2. The crank's ladder is 10 retries at
 * 100 ms doubling to a 5 s cap ≈ 26.3 s, but that figure counts only the sleeps between
 * attempts — it excludes each attempt's own round trip, and the base term is
 * `slot_interval.max(100ms)`, so a slower validator stretches it. MagicBlock's own
 * `test_schedule_error.rs` polls up to 45 s before asserting a task is dead (R6).
 */
export const TICK_STALL_HARD_MS = 45_000;

const WATCHDOG_POLL_MS = 500;
const RESNAPSHOT_MIN_GAP_MS = 2_000;
const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 5_000;

/**
 * `stalled` and `dead` are the *only* crank-health signal that exists: there is no RPC to
 * ask whether a scheduled task is alive (Q14), so `Arena.tick` advancing is the whole
 * observability story.
 */
export type MatchHealth = 'connecting' | 'live' | 'stalled' | 'dead';

export interface MatchSubscriptionConfig {
  /** The pinned ER connection from `connectMatch`. Used for the snapshot only. */
  readonly rpc: HeartrotRpc;
  readonly arena: AccountAddress;
  readonly boss: AccountAddress;
  readonly players: AccountAddress;
  readonly wsUrl?: string;
  /** The game program. A frame whose account is owned by anything else is not the rollup's. */
  readonly owner: AccountAddress;
  /** `tickAt` is when `Arena.tick` last *changed* — feed it to `tickAlpha`. */
  onArena(arena: ArenaAccount, tickAt: number): void;
  onBoss(boss: BossAccount): void;
  /** `previous` is `null` on the first update; it is what `interpolateSeat` lerps from. */
  onPlayers(players: PlayersAccount, previous: PlayersAccount | null): void;
  onHealth(health: MatchHealth): void;
}

export interface MatchSubscription {
  close(): void;
  /** Read all three accounts again and deliver them, whatever the socket has shown since. */
  resnapshot(): void;
}

type AccountKind = 'arena' | 'boss' | 'players';

interface RpcMessage {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
  readonly method?: string;
  readonly params?: {
    readonly subscription?: number;
    readonly result?: {
      readonly context?: { readonly slot?: number };
      readonly value?: { readonly data?: readonly string[]; readonly owner?: string };
    };
  };
}

/**
 * The `[data, 'base64']` pair out of an account response, without depending on which of
 * kit's encoding-specific response types the overload resolved to.
 */
function encodedData(account: { readonly data: unknown }): string | undefined {
  const { data } = account;
  if (!Array.isArray(data)) return undefined;
  const [encoded] = data as readonly unknown[];
  return typeof encoded === 'string' ? encoded : undefined;
}

function fromBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}


/**
 * Is this phase one the crank is supposed to be ticking through?
 *
 * Both, not just `Fighting`. `heartbeat` advances `tick` in every phase, and the crank is
 * armed by `begin_muster` — so a crank that dies during the muster leaves an arena nobody
 * is watching in a phase nobody can leave, which is the exact hang the watchdog exists to
 * end. `MUSTERING → SETTLED` is in `PHASE_EDGES` for that recovery.
 */
function cranking(phase: number): boolean {
  return phase === PHASE_FIGHTING || phase === PHASE_MUSTERING;
}

/**
 * The whole watchdog decision, and pure so it can be checked without a socket or a chain.
 * `null` means "not the watchdog's business" — nothing advances `tick` before the crank is
 * armed, so a lobby with a perfectly healthy socket has a frozen tick by design and judging
 * it would settle every match before it started.
 *
 * `anchorAge` is measured from the newer of the last tick change and the moment the arena
 * entered a cranking phase; see the note in `deliver`.
 */
export function watchdogHealth(phase: number, anchorAge: number): MatchHealth | null {
  if (!cranking(phase)) return null;
  if (anchorAge >= TICK_STALL_HARD_MS) return 'dead';
  if (anchorAge >= TICK_STALL_SOFT_MS) return 'stalled';
  return 'live';
}

/**
 * Subscribe to one match. Returns a handle whose `close()` is the only thing that stops
 * the reconnect loop — a socket that closes on its own is always retried.
 */
export function subscribeMatch(cfg: MatchSubscriptionConfig): MatchSubscription {
  /** Resolved once and reused across reconnects; a failed resolution is not cached. */
  let wsUrl = cfg.wsUrl ?? null;
  const addresses: Record<AccountKind, AccountAddress> = {
    arena: cfg.arena,
    boss: cfg.boss,
    players: cfg.players,
  };

  let socket: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  let nextRequestId = 1;
  const requestKind = new Map<number, AccountKind>();
  const subscriptionKind = new Map<number, AccountKind>();
  /**
   * THE ROUTER RELAYS THE BASE LAYER TOO. Seen live, Sep 4 2026: a rejoin into an arena
   * the Worker had prewarmed seconds earlier took its ER snapshot (roster: our seat), and
   * a second later the router delivered the arena's base-layer create and delegate states
   * — an empty roster — as ordinary accountNotifications at base-layer slots. The feed
   * applied them by subscription id, the seat vanished from the store, the predictor took
   * the zeroed slot and refused every move, and since nothing in a lobby rewrites Players
   * until someone moves, the room stayed bare until a reload.
   *
   * Two facts tell a base-layer frame from the rollup's: its account is owned by the
   * delegation program (the delegated copy) or, for the create itself, its slot belongs to
   * another clock. The rollup's slot counter and devnet's are tens of millions apart and
   * drift further; a raid spans thousands. So the snapshot's slot anchors the clock and a
   * frame more than `SLOT_DOMAIN` away is not from it. The anchor never moves, so the
   * failure mode of a wrong guess is one stale frame, never a frozen feed.
   *
   * `lastSlot` is the newest slot applied per kind: a snapshot delivers a kind unless a
   * frame at or past the snapshot's slot has already been applied for it (the old "fresh"
   * set, made exact). A frame with no slot counts as heard from, at slot 0.
   */
  const lastSlot = new Map<AccountKind, number>();
  let anchorSlot: number | null = null;
  /**
   * The last base64 payload delivered per kind, and the whole of the dedupe.
   *
   * Measured on a live 20-seat devnet feed: **390 of 769 notifications/s are byte-identical
   * repeats** — `Arena` 97.4% of them, because the Magic Router delivers every notification
   * twice and 68.4% of `Players` writes during a fight change no position. Dropping them
   * halves the store updates that reach React, and comparing the *string* rather than the
   * decoded account skips the whole per-notification path below it. It saves no bandwidth;
   * the bytes have already arrived.
   *
   * What that path costs, re-measured 2026-09-02 on a 20-seat-shaped `Players` payload
   * (node 24.10.0, median of 9 reps x 20k calls): `JSON.parse` of the whole notification
   * 1,334 ns, {@link fromBase64} 2,956 ns, `decodePlayers` 1,652 ns — 5,942 ns, of which
   * the DECODER is 28%. The "6.87 µs decode" this note used to claim was the whole path
   * under the decoder's name, and `er_guard.sh`'s `client decode` row inherits the same
   * misattribution: it times `Buffer.from(b64)` inside its `decodeUs` and decodes the
   * duplicates this gate drops. All three shipped decoders together are 1.0 ms/s at the
   * 20-seat frame rate and that row has never read under 3.8, so a move in it is not
   * evidence about a decoder — the two identical-code baseline runs banked the same day
   * (`pair-base-1` vs `pair-base-2`) move it 3.8 -> 6.6 on their own.
   *
   * Cleared on every `open`, which is the load-bearing half: the snapshot-on-open must
   * never be suppressed by a payload cached from before a disconnect, because a reconnect
   * leaves the world up to 1,681 ms stale and that snapshot is the only thing that fixes it.
   */
  let lastPayload = new Map<AccountKind, string>();

  let health: MatchHealth = 'connecting';
  let phase = -1;
  let lastTick = -1;
  let tickAt = 0;
  /** When the arena entered a cranking phase. The watchdog's other anchor — see `deliver`. */
  let crankingAt = 0;
  let lastResnapshotAt = 0;
  let previousPlayers: PlayersAccount | null = null;

  function setHealth(next: MatchHealth): void {
    if (next === health) return;
    health = next;
    cfg.onHealth(next);
  }

  /**
   * Decode and dispatch one base64 payload, unless it is byte-identical to the last one
   * this kind delivered. Every caller goes through here so the snapshot and the live feed
   * share one cache — a notification repeating what the snapshot already delivered is the
   * same duplicate as one repeating a notification.
   */
  function deliverEncoded(kind: AccountKind, encoded: string): void {
    if (lastPayload.get(kind) === encoded) return;
    lastPayload.set(kind, encoded);
    deliver(kind, fromBase64(encoded));
  }

  function deliver(kind: AccountKind, data: Uint8Array): void {
    switch (kind) {
      case 'arena': {
        const arena = decodeArena(data);
        // Entering a cranking phase re-arms the watchdog, and it has to: `begin_muster`
        // flips the phase without touching `tick`, which sits at the 0 `init` wrote until
        // the first `boss_tick` lands ~100 ms later. Anchoring on `tick` alone hands the
        // watchdog an anchor as old as the whole lobby wait, so a match that waited 45 s
        // for a fourth player is reported `dead` in the first poll after it starts — and
        // the caller's response to `dead` is to settle the raid that just began.
        //
        // MUSTERING is the phase this now fires on. FIGHTING is kept in `cranking` for the
        // watchdog's own test, but the transition into it no longer needs an anchor: the
        // crank has been advancing `tick` for the whole 20 s window by then.
        //
        // Deliberately a second variable and not a write to `tickAt`: that one is the
        // interpolation anchor `tickAlpha` reads, and moving it on anything but a real
        // tick makes every knight on screen lurch.
        if (arena.phase !== phase && cranking(arena.phase) && !cranking(phase)) {
          crankingAt = performance.now();
        }
        phase = arena.phase;
        // Only a *tick change* re-anchors the clock. `shoot` rewrites `Arena` without
        // advancing `tick`, and treating that as a tick would make the interpolation
        // alpha jump backwards every time somebody fires.
        if (arena.tick !== lastTick) {
          lastTick = arena.tick;
          tickAt = performance.now();
        }
        cfg.onArena(arena, tickAt);
        break;
      }
      case 'boss':
        cfg.onBoss(decodeBoss(data));
        break;
      case 'players': {
        const players = decodePlayers(data);
        cfg.onPlayers(players, previousPlayers);
        previousPlayers = players;
        break;
      }
    }
  }

  async function snapshot(): Promise<void> {
    const kinds: AccountKind[] = ['arena', 'boss', 'players'];
    const { context, value } = await cfg.rpc
      .getMultipleAccounts([cfg.arena, cfg.boss, cfg.players], { encoding: 'base64' })
      .send();
    const slot = Number(context?.slot ?? 0);
    if (anchorSlot === null && Number.isFinite(slot) && slot > 0) anchorSlot = slot;
    for (let i = 0; i < kinds.length; i++) {
      const kind = kinds[i];
      const account = value[i];
      if (kind === undefined || account == null) continue;
      // A notification that arrived while this request was in flight is newer than the
      // snapshot; letting the snapshot win would rewind the world by one round trip.
      if ((lastSlot.get(kind) ?? -1) >= slot) continue;
      lastSlot.set(kind, slot);
      const encoded = encodedData(account);
      if (encoded !== undefined) deliverEncoded(kind, encoded);
    }
  }

  function handle(message: RpcMessage): void {
    if (message.error !== undefined) {
      // A failed subscribe leaves the feed silently dead. Drop the socket and let the
      // backoff rebuild it rather than sitting on a connection that delivers nothing.
      socket?.close();
      return;
    }
    if (message.id !== undefined && typeof message.result === 'number') {
      const kind = requestKind.get(message.id);
      if (kind !== undefined) subscriptionKind.set(message.result, kind);
      return;
    }
    if (message.method !== 'accountNotification') return;
    const subscription = message.params?.subscription;
    if (subscription === undefined) return;
    const kind = subscriptionKind.get(subscription);
    const result = message.params?.result;
    const encoded = result?.value?.data?.[0];
    if (kind === undefined || encoded === undefined) return;
    if (result?.value?.owner !== undefined && result.value.owner !== cfg.owner) return;
    const slot = Number(result?.context?.slot ?? 0);
    if (anchorSlot !== null && Number.isFinite(slot) && Math.abs(slot - anchorSlot) > SLOT_DOMAIN) return;
    // Before the dedupe returns: a duplicate is still proof the feed is delivering, and
    // `snapshot` must know this kind has been heard from, and at what slot.
    lastSlot.set(kind, Math.max(slot, lastSlot.get(kind) ?? 0));
    deliverEncoded(kind, encoded);
  }

  /**
   * The router, unless a caller explicitly overrides it.
   *
   * Bypassing the proxy to subscribe on the ER's own websocket sounds obviously faster and
   * measured ZERO — three times, paired per seq across 1,848 writes, with the router 1-5 ms
   * AHEAD at the median and winning 73-87% of individual writes. The reason is in the DNS:
   *
   *   devnet-router.magicblock.app   IPv4 29.6 ms   IPv6 190.1 ms   (Cloudflare anycast)
   *   devnet-as.magicblock.app       IPv4 132.7 ms  IPv6 138.9 ms   (one box, Singapore)
   *
   * The router is an edge 30 ms away that proxies; the ER is an origin 133 ms away. Trading
   * the first for the second loses. An earlier measurement claiming a 32-40 ms router
   * penalty had resolved the router over IPv6, where Cloudflare's anycast is 160 ms further
   * from this ISP — it was timing the wrong address family, not the proxy.
   *
   * So this stays the router, and the ER-resolution machinery is deleted rather than left
   * behind a flag: it cost two round trips at match start and carried the worst failure
   * mode in this system, since reading a delegated account from the wrong ER returns
   * correctly-owned but silently frozen data with no error and no notification.
   */
  function resolveWsUrl(): string {
    return wsUrl ?? ROUTER_WS_ENDPOINT;
  }

  async function connect(): Promise<void> {
    setHealth('connecting');
    const url = resolveWsUrl();
    if (closed) return;
    const ws = new WebSocket(url);
    socket = ws;

    ws.onopen = () => {
      attempt = 0;
      requestKind.clear();
      subscriptionKind.clear();
      lastSlot.clear();
      lastPayload = new Map();
      for (const kind of ['arena', 'boss', 'players'] as const) {
        const id = nextRequestId++;
        requestKind.set(id, kind);
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'accountSubscribe',
            params: [addresses[kind], { encoding: 'base64' }],
          }),
        );
      }
      // Subscribe first, then snapshot: the reverse order loses every write that lands
      // between the two, and `lastSlot` resolves the race the other way.
      void snapshot().catch(() => undefined);
      setHealth('live');
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      handle(JSON.parse(event.data) as RpcMessage);
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onclose = () => {
      if (closed || socket !== ws) return;
      socket = null;
      setHealth('connecting');
      // Exponential with jitter. The jitter is not decoration: twenty clients dropped by
      // one ER blip must not all come back on the same millisecond.
      const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
      attempt++;
      reconnectTimer = setTimeout(() => void connect(), delay * (0.5 + Math.random() / 2));
    };
  }

  const watchdog = setInterval(() => {
    if (tickAt === 0) return;
    const verdict = watchdogHealth(phase, performance.now() - Math.max(tickAt, crankingAt));
    if (verdict === null) return;
    if (verdict === 'dead') {
      setHealth('dead');
      return;
    }
    if (verdict === 'stalled') {
      setHealth('stalled');
      const now = performance.now();
      if (now - lastResnapshotAt >= RESNAPSHOT_MIN_GAP_MS) {
        lastResnapshotAt = now;
        lastSlot.clear();
        void snapshot().catch(() => undefined);
      }
      return;
    }
    // Only claim `live` while the pipe carrying the world is actually open.
    if (socket?.readyState === WebSocket.OPEN) setHealth('live');
  }, WATCHDOG_POLL_MS);

  void connect();

  return {
    resnapshot() {
      lastSlot.clear();
      void snapshot().catch(() => undefined);
    },
    close() {
      closed = true;
      clearInterval(watchdog);
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      socket?.close();
      socket = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------

/**
 * The watchdog is the one branch here whose every failure is silent and expensive: a false
 * `dead` settles a live raid, and a missed one leaves twenty players staring at a frozen
 * world. Dev-only, in the same style as `state/store.ts`'s `screenOf` check.
 *
 * The anchor is restated rather than imported because it *is* the thing under test — the
 * `Math.max` in the watchdog body and the `crankingAt` write in `deliver` are one rule
 * split across two places, and case 3 is the regression that rule exists for.
 */
if (import.meta.env.DEV) {
  const NOW = 1_000_000;
  const anchorAge = (tickAt: number, crankingAt: number): number =>
    NOW - Math.max(tickAt, crankingAt);

  const cases: readonly (readonly [string, number, number, MatchHealth | null])[] = [
    // [name, phase, anchorAge, expected]
    ['lobby ticks are frozen by design', 0, 600_000, null],
    ['a fresh tick is a live crank', PHASE_FIGHTING, 400, 'live'],
    ['seven missed ticks is a warning, not a death', PHASE_FIGHTING, TICK_STALL_SOFT_MS, 'stalled'],
    // The crank's own retry ladder is ~26 s of sleeps plus each attempt's round trip, so
    // anything tighter than this reports a recovering match as a dead one.
    ['26 s of crank retries is still not dead', PHASE_FIGHTING, 26_000, 'stalled'],
    ['past the hard limit the task is gone', PHASE_FIGHTING, TICK_STALL_HARD_MS, 'dead'],
    // 3: `begin_muster` flips the phase without touching `tick`, so a 90 s lobby wait
    // leaves `tickAt` 90 s old at the instant the window opens. Without `crankingAt` this
    // is 'dead' and the caller settles a raid one poll into its first tick.
    ['a long lobby wait does not kill a fresh muster', PHASE_MUSTERING, anchorAge(NOW - 90_000, NOW), 'live'],
    // The muster is watched, and that is the point of extending it: the crank is armed by
    // `begin_muster`, so one that dies here leaves a phase with no exit but the settle.
    ['a muster that stalls is reported dead', PHASE_MUSTERING, TICK_STALL_HARD_MS, 'dead'],
    // ...and once the fight is genuinely stalled, the phase-entry anchor stops mattering.
    ['a real stall outlives the phase-entry anchor', PHASE_FIGHTING, anchorAge(NOW - 60_000, NOW - 50_000), 'dead'],
  ];

  for (const [name, phase, age, expected] of cases) {
    const actual = watchdogHealth(phase, age);
    if (actual !== expected) {
      throw new Error(`subscribe self-check: ${name} should be '${expected}', got '${actual}'`);
    }
  }

  // ---- the payload dedupe, driven through the real socket handlers -------------------
  //
  // The other silent branch in this file. All three of its constraints fail invisibly —
  // the feed keeps working and only the thing the dedupe was supposed to protect breaks —
  // so the whole subscription is driven here rather than a cache tested in isolation:
  // two of the three constraints are properties of the *call sites*, not of the compare.
  //
  //   1. per kind, and before the decoder — the compare is the only reason it saves CPU;
  //   2. dropped on every `open` — otherwise a reconnect's snapshot repeats a payload
  //      cached before the disconnect, is suppressed, and the client renders the world it
  //      left 1,681 ms ago, forever, with a healthy socket;
  //   3. a suppressed frame still counts as liveness.
  //
  // The payload is 'AAAA': valid base64 (so `atob` is happy) decoding to three zero bytes,
  // which every decoder rejects on length. So "the decoder ran" is observable as a throw
  // and "the gate stopped it first" as silence — no 1,200-byte fixture needed, and it is
  // the gate's *ordering* that is under test, which a valid payload could not show.
  const DUP = 'AAAA';

  const built: FakeSocket[] = [];
  class FakeSocket {
    readonly sent: { readonly id: number }[] = [];
    readyState = 1;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(_url: string) {
      built.push(this);
    }
    send(raw: string): void {
      this.sent.push(JSON.parse(raw) as { id: number });
    }
    close(): void {
      this.readyState = 3;
    }
  }

  // Every snapshot is held open and released by hand, one gate per `open`, because the
  // order the snapshots land in is the only lever that can isolate constraint 3. The
  // account is a getter: `snapshot` reads `data` only for a kind it has NOT heard from
  // since the open, so the read count *is* the `fresh` guard, observed from outside.
  let snapshotReads = 0;
  const gates: (() => void)[] = [];
  const snapshotAccount = {
    get data(): readonly string[] {
      snapshotReads++;
      return [DUP, 'base64'];
    },
  };
  const fakeRpc = {
    getMultipleAccounts: () => ({
      send: async () => {
        await new Promise<void>((resolve) => gates.push(resolve));
        return { value: [snapshotAccount, null, null] };
      },
    }),
  } as unknown as HeartrotRpc;

  const realWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  const sub = subscribeMatch({
    rpc: fakeRpc,
    arena: 'arena' as unknown as AccountAddress,
    boss: 'boss' as unknown as AccountAddress,
    players: 'players' as unknown as AccountAddress,
    owner: 'program' as unknown as AccountAddress,
    onArena: () => {},
    onBoss: () => {},
    onPlayers: () => {},
    onHealth: () => {},
  });
  // `connect` reaches `new WebSocket` with nothing awaited before it, so the socket exists
  // by now. Restore immediately: nothing here ever fires `onclose`, so the reconnect timer
  // that would build a real socket is never armed.
  globalThis.WebSocket = realWebSocket;
  const ws = built[0];
  if (ws === undefined) throw new Error('subscribe self-check: no socket was constructed');

  const expect = (ok: boolean, name: string): void => {
    if (!ok) throw new Error(`subscribe self-check: ${name}`);
  };
  /** Open, then answer the three `accountSubscribe` requests so notifications route. */
  const open = (): void => {
    ws.onopen?.();
    for (const [i, request] of ws.sent.entries()) {
      ws.onmessage?.({ data: JSON.stringify({ id: request.id, result: 100 + i }) });
    }
    ws.sent.length = 0;
  };
  /** Feed one notification; `true` if it reached the decoder, which this payload kills. */
  const reachedDecoder = (subscription: number, payload: string): boolean => {
    const data = JSON.stringify({
      method: 'accountNotification',
      params: { subscription, result: { value: { data: [payload, 'base64'] } } },
    });
    try {
      ws.onmessage?.({ data });
      return false;
    } catch {
      return true;
    }
  };

  try {
    open();
    expect(reachedDecoder(100, DUP), 'the first payload of a kind must reach the decoder');
    expect(!reachedDecoder(100, DUP), 'a byte-identical repeat must be dropped before the decoder runs');
    expect(reachedDecoder(101, DUP), 'the cache is keyed by account kind, not by payload');
    // 2, and the one that matters: this is a reconnect. The cache still holds arena's DUP
    // from before it, and the snapshot that follows an `open` is the only thing that
    // un-freezes a world up to 1,681 ms stale — suppressing it strands the player.
    open();
    expect(
      reachedDecoder(100, DUP),
      'an `open` must clear the cache, or the snapshot-on-open is suppressed and the world freezes',
    );
  } catch (error) {
    sub.close();
    throw error;
  }

  // 3, and the fiddly one. `handle` marks the kind fresh *before* the gate, so a suppressed
  // frame still tells `snapshot` this kind has been heard from since the open. To pin that
  // to the *suppressed* frame the check needs a state no normal sequence produces — cache
  // full, `fresh` empty — because the first notification after an open is never a
  // duplicate. A snapshot landing late into a later open is exactly that state: it fills
  // the cache and never touches `fresh`. So the whole point of holding the gates is to let
  // the first open's snapshot arrive during the third, and then read the guard off the
  // third's own snapshot.
  //
  // Async because the snapshot resumes through two awaits; a macrotask clears both.
  void (async () => {
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    try {
      open();
      gates[0]?.(); // the first open's snapshot, landing two reconnects late
      await settle();
      expect(snapshotReads === 1, 'the stale snapshot should have delivered into the fresh open');
      expect(!reachedDecoder(100, DUP), 'a payload the snapshot already delivered is a duplicate');
      gates[2]?.(); // this open's own snapshot: it must find the kind already heard from
      await settle();
      expect(
        snapshotReads === 1,
        'a suppressed frame must still count as liveness, or the snapshot rewinds the kind it repeated',
      );
    } finally {
      sub.close();
    }
  })();
}
