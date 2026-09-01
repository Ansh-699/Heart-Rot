/**
 * The whole of HEARTROT's client state, in one external store.
 *
 * There are three things worth keeping: who you are (`sessionKey`, `match`), what the
 * chain says (`arena`, `boss`, `players`), and whether the pipe carrying the second is
 * alive (`status`). Three fields do not justify a state library, and a reducer over them
 * would be more ceremony than the transitions have content — so this is a plain mutable
 * object behind `useSyncExternalStore`, which is the API React added for exactly this.
 *
 * The screen is **derived**, not stored. Where you are is a fact about your session and
 * your seat's `zone`, and a stored copy of that fact is a copy that can disagree with the
 * chain — a player who walks through the gate and stays on the lobby screen because a
 * `setScreen` never fired. `screenOf` recomputes it; there is nothing to keep in sync.
 *
 * The three cold routes live here too, because each one is a state transition and none is
 * on the gameplay path. `move`, `shoot` and `enter_gate` are **not** here and must never
 * be: they go browser → ER directly, signed by the session key, and a Worker round trip in
 * that path throws away the entire reason for the rollup.
 */

import {
  createContext,
  createElement,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { recordWorld } from '../net/metrics';

import {
  ZONE_ARENA,
  loadOrCreateSession,
  type ArenaAccount,
  type BossAccount,
  type PlayerSlot,
  type PlayersAccount,
  type Session,
} from '@heartrot/client';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** The four screens. One linear flow, so this is a union and not a router. */
export type Screen = 'onboarding' | 'select' | 'lobby' | 'arena';

/**
 * How much of the world we can currently believe.
 *
 * `stale` is the one that matters and the one the sync layer sets: `Arena.tick` is the
 * only crank-liveness signal that exists — no RPC reports whether a scheduled task is
 * still armed — so a client that stops seeing it advance is looking at a frozen world
 * with no error anywhere to tell it so.
 */
export type ConnectionStatus =
  | 'idle'
  | 'joining'
  | 'connecting'
  | 'live'
  | 'stale'
  | 'settling'
  | 'error';

/** The routing bundle `POST /api/session/init` hands back. Every field is load-bearing. */
export type MatchInfo = {
  seat: number;
  /** u64 as a decimal string, the shape it crosses the wire in both directions. */
  arenaId: string;
  incarnation: number;
  arenaPda: string;
  bossPda: string;
  playersPda: string;
  programId: string;
  /** The concrete ER. Never resolve one independently — the wrong ER answers with
   *  correctly-owned, silently frozen data. */
  erEndpoint: string;
  routerEndpoint: string;
  validatorIdentity: string;
  /** Crank interval, for sizing the staleness watchdog. */
  tickMs: number;
};

export type State = {
  /** A Privy sign-in has succeeded at least once this page load. */
  authenticated: boolean;
  /** The non-extractable WebCrypto keypair. Holds zero SOL, forever. */
  sessionKey: Session | null;
  skinId: number;
  match: MatchInfo | null;
  status: ConnectionStatus;
  /** Player-readable. Rendered; never a stack trace, never a token. */
  error: string | null;
  arena: ArenaAccount | null;
  boss: BossAccount | null;
  players: PlayersAccount | null;
  /** `Date.now()` of the last accepted account update. The watchdog's input. */
  updatedAt: number;
};

export type WorldUpdate = {
  arena?: ArenaAccount;
  boss?: BossAccount;
  players?: PlayersAccount;
};

export type Store = {
  getState(): State;
  subscribe(listener: () => void): () => void;
  /** Prove identity. Resolves the session keypair at the same time. */
  signIn(): Promise<void>;
  setSkin(skinId: number): void;
  /** `POST /api/session/init` — identity in, a seat and a routing bundle out. */
  join(): Promise<void>;
  /** `POST /api/match/start` — delegate and arm the crank. 5–15 s of devnet round trips. */
  startMatch(): Promise<void>;
  /** `POST /api/match/settle` — end the match and write the leaderboard. Retries by design. */
  settle(): Promise<void>;
  /** Owned by the subscription layer: one call per accepted notification. */
  setWorld(update: WorldUpdate): void;
  setStatus(status: ConnectionStatus, error?: string): void;
  /** Drop the finished match. The next `join` gets a fresh seat in the next arena. */
  leaveMatch(): void;
};

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Returns a currently-valid Privy access token. Called fresh for every request.
 *
 * The whole of the app's dependency on Privy is this one function type. `main.tsx` is the
 * only file that knows the SDK exists (plus `screens/Onboarding.tsx`, which needs the
 * connect modal itself), and `setAuthSource` is the seam between them.
 */
export type AuthSource = () => Promise<string>;

let authSource: AuthSource = () =>
  Promise.reject(new Error('Sign-in is unavailable: no identity provider is installed.'));

/**
 * Install the identity provider. The Privy React SDK is not a dependency of this package
 * — the shell only ever needs "give me a token" — so whatever module owns Privy calls
 * this once at startup and nothing else in the app imports it.
 */
export function setAuthSource(source: AuthSource): void {
  authSource = source;
}

// ---------------------------------------------------------------------------
// Cold-path fetch
// ---------------------------------------------------------------------------

/**
 * `run_worker_first: ["/api/*"]` means this prefix is the only path that reaches the
 * Worker at all, in production and (via the Vite proxy) in development.
 */
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code =
      typeof payload === 'object' && payload !== null && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `http_${response.status}`;
    throw new Error(code);
  }
  return payload as T;
}

/**
 * Route error codes, in the words a player can act on. Anything unlisted is shown raw —
 * an unfamiliar code on screen is more useful than a reassuring lie.
 */
const MESSAGES: Record<string, string> = {
  treasury_low: 'The devnet treasury is out of SOL. Nothing can start until it is topped up.',
  match_in_progress: 'A raid is already underway. Wait for it to end and try again.',
  arena_full: 'All 20 seats are taken. Try again when the raid ends.',
  seat_contended: 'Twenty browsers wanted the same seat. Try again.',
  already_started: 'That raid has already started.',
  wrong_arena: 'The lobby moved on to a newer arena. Rejoining.',
  match_live: 'The raid is still running.',
  nothing_to_settle: 'There is nothing to settle.',
  rate_limited: 'Too many requests from this network. Wait a moment.',
  rate_limiter_unconfigured: 'The backend is misconfigured and is refusing to spend SOL.',
};

function readable(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return MESSAGES[raw] ?? raw;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** Statuses an incoming account update may not overwrite. See `setWorld`. */
const HELD: readonly ConnectionStatus[] = ['error', 'joining', 'settling'];

const INITIAL: State = {
  authenticated: false,
  sessionKey: null,
  skinId: 0,
  match: null,
  status: 'idle',
  error: null,
  arena: null,
  boss: null,
  players: null,
  updatedAt: 0,
};

export function createStore(): Store {
  let state = INITIAL;
  const listeners = new Set<() => void>();

  // The settle route is deliberately safe to re-enter, but every client in a 20-player
  // raid sees `phase == Settling` on the same notification. Without this they all fire at
  // once and nineteen of them pay for a 25-second commit poll to learn nothing.
  let settling = false;
  // Same shape at the other end of the match: `start` spends ~0.0245 SOL of treasury rent
  // and takes 5–15 s, and a double-click during it earns a 409 rather than a second raid.
  let starting = false;

  const set = (patch: Partial<State>): void => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  /**
   * Every action is invoked fire-and-forget from an event handler, so a rethrow here
   * would only become an unhandled rejection nobody reads. The error goes into state,
   * which is the one place the player can actually see it.
   */
  const fail = (error: unknown): void => {
    set({ status: 'error', error: readable(error) });
  };

  /**
   * The one place a Privy token is fetched, so the one place its absence is handled.
   *
   * A browser wallet has a Disconnect button, and pressing it invalidates the session that
   * `authSource` refreshes against. Left alone that strands the player: `authenticated`
   * stays true, `screenOf` keeps returning `'select'`, and every "Take a seat" fails
   * forever with no way back to the connect card. Clearing the flag here sends them back
   * to the one screen that can fix it.
   *
   * Only before a seat exists, though. Gameplay is signed by the session key and needs no
   * token at all, so evicting a live raider to the connect card because a `settle` token
   * fetch blipped would be strictly worse than letting `settle` retry.
   */
  const token = async (): Promise<string> => {
    try {
      return await authSource();
    } catch (error) {
      if (!state.match) set({ authenticated: false });
      throw error;
    }
  };

  /** Every route wants a token and most want the arena id. One place to get both wrong. */
  const credentials = async (): Promise<{ privyToken: string; arenaId: string }> => {
    const { match } = state;
    if (!match) throw new Error('no match joined');
    return { privyToken: await token(), arenaId: match.arenaId };
  };

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async signIn() {
      set({ status: 'joining', error: null });
      try {
        // Both in flight: the key generation is local and the token is a network hop, and
        // neither needs the other. `loadOrCreateSession` is single-flight per page, so
        // React 19's double-invoked effects cannot race two keys into existence.
        const [sessionKey] = await Promise.all([loadOrCreateSession(), token()]);
        set({ authenticated: true, sessionKey, status: 'idle' });
      } catch (error) {
        fail(error);
      }
    },

    setSkin(skinId) {
      set({ skinId });
    },

    async join() {
      const { sessionKey, skinId } = state;
      set({ status: 'joining', error: null });
      try {
        if (!sessionKey) throw new Error('Sign in before taking a seat.');
        const match = await postJson<MatchInfo>('/api/session/init', {
          privyToken: await token(),
          sessionPubkey: sessionKey.address,
          skinId,
        });
        // `connecting`, not `live`: a seat is not a subscription. The world stays null
        // until the sync layer has taken its `getMultipleAccounts` snapshot, because
        // subscribing alone delivers nothing until the next write.
        set({ match, status: 'connecting' });
      } catch (error) {
        fail(error);
      }
    },

    async startMatch() {
      if (starting) return;
      starting = true;
      set({ status: 'joining', error: null });
      try {
        await postJson<unknown>('/api/match/start', await credentials());
        set({ status: 'connecting' });
      } catch (error) {
        fail(error);
      } finally {
        starting = false;
      }
    },

    async settle() {
      if (settling) return;
      settling = true;
      set({ status: 'settling', error: null });
      try {
        const body = await credentials();
        // A 202 means *unknown*, not failed — the commit has not been observed landing on
        // the base layer yet. The route is idempotent on `(arena_id, incarnation)`
        // precisely so this loop is safe.
        for (let attempt = 0; attempt < 8; attempt++) {
          const result = await postJson<{ committed: boolean; retryAfterMs?: number }>(
            '/api/match/settle',
            body,
          );
          if (result.committed) return;
          await new Promise((resolve) => setTimeout(resolve, result.retryAfterMs ?? 2_000));
        }
        throw new Error('The raid is taking an unusually long time to settle.');
      } catch (error) {
        fail(error);
      } finally {
        settling = false;
      }
    },

    setWorld(update) {
      // The one place every account update lands, so the one place telemetry needs to
      // observe. `lastMoveSeq` on the local seat is what turns a fire-and-forget send
      // into a measurable round trip; without a seat there is throughput but no latency.
      const seat = state.match?.seat;
      const slot = seat === undefined || seat === null ? undefined : update.players?.slots?.[seat];
      recordWorld(update.arena?.tick, slot?.lastMoveSeq);

      set({
        ...update,
        updatedAt: Date.now(),
        // An update arriving is itself proof the pipe recovered, so `connecting`, `stale`
        // and `idle` all resolve to `live` here. The three below do not: they are states
        // the player caused and is waiting on, and a notification from an unrelated
        // account must not quietly report them finished.
        status: HELD.includes(state.status) ? state.status : 'live',
      });
    },

    setStatus(status, error) {
      set({ status, error: error ?? (status === 'error' ? state.error : null) });
    },

    leaveMatch() {
      settling = false;
      set({ match: null, arena: null, boss: null, players: null, status: 'idle', error: null });
    },
  };
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** Your own seat, or null before the roster has arrived. */
export function mySeatSlot(state: State): PlayerSlot | null {
  const { match, players } = state;
  if (!match || !players) return null;
  return players.slots[match.seat] ?? null;
}

/**
 * Where the player is, derived rather than stored.
 *
 * The lobby/arena split is `zone`, which only the chain writes: walking onto the gate tile
 * flips it, and the screen follows on the next notification. Nothing local decides it.
 */
export function screenOf(state: State): Screen {
  if (!state.authenticated) return 'onboarding';
  if (!state.match) return 'select';
  return mySeatSlot(state)?.zone === ZONE_ARENA ? 'arena' : 'lobby';
}

// ---------------------------------------------------------------------------
// React binding
// ---------------------------------------------------------------------------

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const store = useMemo(createStore, []);
  return createElement(StoreContext.Provider, { value: store }, children);
}

/** The store itself — a stable reference, for actions. Never re-renders a component. */
export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore outside <StoreProvider>');
  return store;
}

/**
 * Subscribe to one slice.
 *
 * `select` must return a primitive or a reference already living in the state object.
 * Building a fresh object or array inside it makes every snapshot compare unequal, and
 * React responds by re-rendering forever rather than by warning.
 */
export function useSelect<T>(select: (state: State) => T): T {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => select(store.getState()));
}

// ---------------------------------------------------------------------------
// Self-check
//
// `screenOf` is the router, and four other modules render off it. Every one of its
// failures is silent — a wrong branch shows the wrong screen, never an error — and the
// one that has actually happened is the first line: a client that never installed an
// `AuthSource`, so `authenticated` stayed false and the app never left onboarding. Dev-only.
// ---------------------------------------------------------------------------

if (import.meta.env.DEV) {
  const slot = (zone: number): PlayerSlot => ({ zone }) as PlayerSlot;
  const seated = (zone: number): Partial<State> => ({
    authenticated: true,
    match: { seat: 3 } as MatchInfo,
    players: { slots: [slot(0), slot(0), slot(0), slot(zone)] } as PlayersAccount,
  });

  const cases: readonly (readonly [string, Partial<State>, Screen])[] = [
    ['signed out', {}, 'onboarding'],
    ['no seat yet', { authenticated: true }, 'select'],
    // A seat with no roster yet is still the lobby, not the arena: `mySeatSlot` is null
    // until the first `Players` notification lands, and guessing "arena" there would drop
    // the player into a stage with nothing on it.
    ['seat, roster pending', { authenticated: true, match: { seat: 3 } as MatchInfo }, 'lobby'],
    ['in the lobby', seated(0), 'lobby'],
    ['through the gate', seated(ZONE_ARENA), 'arena'],
  ];

  for (const [name, patch, expected] of cases) {
    const actual = screenOf({ ...INITIAL, ...patch });
    if (actual !== expected) {
      throw new Error(`store self-check: ${name} should be '${expected}', got '${actual}'`);
    }
  }
}
