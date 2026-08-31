/**
 * The live state feed: one WebSocket, three accounts, and a watchdog on the only
 * liveness signal that exists.
 *
 * Everything below is empirical — **zero of MagicBlock's 215 documentation pages mention
 * `Subscribe`** — and each rule is here because breaking it fails silently rather than
 * loudly (`realtime-sync.md`, `01-architecture.md` §6.2):
 *
 * - **The router WS, not the ER's.** Raced on the same delegated account for 25 s across
 *   488 matched slots the router costs a p50 of −4 ms, and it survives re-delegation
 *   without the client resolving an fqdn. It supports **only** `accountSubscribe` and
 *   `signatureSubscribe`; `programSubscribe`, `logsSubscribe` and `slotSubscribe` are all
 *   `-32601`, so a client that assumes pubsub parity gets nothing and no error.
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
  /** `tickAt` is when `Arena.tick` last *changed* — feed it to `tickAlpha`. */
  onArena(arena: ArenaAccount, tickAt: number): void;
  onBoss(boss: BossAccount): void;
  /** `previous` is `null` on the first update; it is what `interpolateSeat` lerps from. */
  onPlayers(players: PlayersAccount, previous: PlayersAccount | null): void;
  onHealth(health: MatchHealth): void;
}

export interface MatchSubscription {
  close(): void;
}

type AccountKind = 'arena' | 'boss' | 'players';

interface RpcMessage {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
  readonly method?: string;
  readonly params?: {
    readonly subscription?: number;
    readonly result?: { readonly value?: { readonly data?: readonly string[] } };
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
 * Subscribe to one match. Returns a handle whose `close()` is the only thing that stops
 * the reconnect loop — a socket that closes on its own is always retried.
 */
export function subscribeMatch(cfg: MatchSubscriptionConfig): MatchSubscription {
  const wsUrl = cfg.wsUrl ?? ROUTER_WS_ENDPOINT;
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
  /** Kinds that have received a live notification since this `open`. */
  let fresh = new Set<AccountKind>();

  let health: MatchHealth = 'connecting';
  let phase = -1;
  let lastTick = -1;
  let tickAt = 0;
  let lastResnapshotAt = 0;
  let previousPlayers: PlayersAccount | null = null;

  function setHealth(next: MatchHealth): void {
    if (next === health) return;
    health = next;
    cfg.onHealth(next);
  }

  function deliver(kind: AccountKind, data: Uint8Array): void {
    switch (kind) {
      case 'arena': {
        const arena = decodeArena(data);
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
    const { value } = await cfg.rpc
      .getMultipleAccounts([cfg.arena, cfg.boss, cfg.players], { encoding: 'base64' })
      .send();
    for (let i = 0; i < kinds.length; i++) {
      const kind = kinds[i];
      const account = value[i];
      if (kind === undefined || account == null) continue;
      // A notification that arrived while this request was in flight is newer than the
      // snapshot; letting the snapshot win would rewind the world by one round trip.
      if (fresh.has(kind)) continue;
      const encoded = encodedData(account);
      if (encoded !== undefined) deliver(kind, fromBase64(encoded));
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
    const encoded = message.params?.result?.value?.data?.[0];
    if (kind === undefined || encoded === undefined) return;
    fresh.add(kind);
    deliver(kind, fromBase64(encoded));
  }

  function connect(): void {
    setHealth('connecting');
    const ws = new WebSocket(wsUrl);
    socket = ws;

    ws.onopen = () => {
      attempt = 0;
      requestKind.clear();
      subscriptionKind.clear();
      fresh = new Set();
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
      // between the two, and the `fresh` guard above resolves the race the other way.
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
      reconnectTimer = setTimeout(connect, delay * (0.5 + Math.random() / 2));
    };
  }

  const watchdog = setInterval(() => {
    // The crank only advances `tick` while `phase == Fighting` — `boss_tick` returns
    // early otherwise — so a lobby with a perfectly healthy socket has a frozen tick by
    // design. Running the watchdog there would settle every match before it started.
    if (phase !== PHASE_FIGHTING || tickAt === 0) return;

    const age = performance.now() - tickAt;
    if (age >= TICK_STALL_HARD_MS) {
      setHealth('dead');
      return;
    }
    if (age >= TICK_STALL_SOFT_MS) {
      setHealth('stalled');
      const now = performance.now();
      if (now - lastResnapshotAt >= RESNAPSHOT_MIN_GAP_MS) {
        lastResnapshotAt = now;
        fresh = new Set();
        void snapshot().catch(() => undefined);
      }
      return;
    }
    if (socket?.readyState === WebSocket.OPEN) setHealth('live');
  }, WATCHDOG_POLL_MS);

  connect();

  return {
    close() {
      closed = true;
      clearInterval(watchdog);
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      socket?.close();
      socket = null;
    },
  };
}
