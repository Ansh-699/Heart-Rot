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
  CLASS_ARCHER,
  ZONE_ARENA,
  guestProof,
  loadOrCreateSession,
  type ArenaAccount,
  type BossAccount,
  type GuestProof,
  type PlayerSlot,
  type PlayersAccount,
  type Session,
} from '@heartrot/client';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/**
 * The screens of one linear flow, plus the leaderboard — a detour off the landing and
 * back, which is why it is a flag (`State.leaderboard`) and not a step. Still a union and
 * not a router.
 *
 * `joining` is the loader: a signed-in player with no seat and a marker already on file.
 * It is where every rejoin lives — after a verdict, after Exit, after a lost seat — and
 * the select is not it. "Nobody wants that annoying popup": the select is seen once, and
 * again only by asking (`changeMarker`).
 */
export type Screen = 'onboarding' | 'select' | 'joining' | 'lobby' | 'arena' | 'leaderboard';

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
  /** `join` was told "not yet" (`WARMING`) and is retrying on its own. See `join`. */
  | 'warming'
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
  /**
   * An identity this tab can prove: a Privy sign-in has succeeded at least once this
   * page load, or the tab is a guest and the session key itself is the proof.
   */
  authenticated: boolean;
  /**
   * Playing without a wallet. The routes get `guestProof` instead of a Privy token and
   * the identity is the session key's — as many raids as the key lasts, and the verdict
   * carries one muted line offering a name on the leaderboard (`ui/Hud.tsx`). The
   * one-raid block that used to sit here was the popup the player asked to lose.
   */
  guest: boolean;
  /** The leaderboard is open. Set from the landing, cleared by its Back link. */
  leaderboard: boolean;
  /** The non-extractable WebCrypto keypair. Holds zero SOL, forever. */
  sessionKey: Session | null;
  skinId: number;
  /**
   * A seat has been taken with `skinId` — this page load or an earlier one (localStorage
   * `heartrot.skin`). It is the whole of the difference between `'select'` and
   * `'joining'` in `screenOf`: a marker on file means the select has nothing left to ask,
   * so a seatless player gets the loader and the store takes the next seat by itself.
   */
  skinChosen: boolean;
  /**
   * The player asked for a seat this page load — Play, Sign in, a rejoin, a marker
   * change. Without it a returning player with a session on file landed on the loader
   * the moment the page opened, "building the arena" before they could read a word.
   * The landing is the resting screen; a seat is taken on a click and nowhere else.
   */
  seeking: boolean;
  /**
   * Always `CLASS_ARCHER`: the archer is the only class this client sends. Still a field
   * because it travels inside `claim_seat` and `App.tsx` compares it to a returning seat's
   * class, which the chain keeps (class 0 seats still exist).
   */
  classId: number;
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
  /**
   * The arena PDA of the feed this came from. A feed outlives the match it was opened
   * for by a round trip — its socket is closed on the effect's cleanup, but a decode
   * already in flight still lands — and a roster from the PREVIOUS arena, where our old
   * seat is empty, arriving after the new seat was seen occupied is what bounced players
   * back to the character select right after taking a seat. `setWorld` drops anything
   * not from the match it holds.
   */
  from: string;
};

export type Store = {
  getState(): State;
  subscribe(listener: () => void): () => void;
  /** Prove identity. Resolves the session keypair at the same time. */
  signIn(): Promise<void>;
  /**
   * Take a seat without a wallet. The session key is created as for `signIn` and is the
   * whole identity; `join` follows immediately, because a guest has nothing to choose —
   * the colour is cosmetic and the landing's one button promised play, not a form.
   */
  playAsGuest(): Promise<void>;
  showLeaderboard(): void;
  hideLeaderboard(): void;
  setSkin(skinId: number): void;
  /**
   * `POST /api/session/init` — identity in, a seat and a routing bundle out.
   *
   * Refused with `no_open_arena` or `try_again`, it does not fail: the Worker creates and
   * delegates the next arena in the background of the refusal (`routes.ts::prewarmNext`,
   * 30–60 s of devnet round trips), so the honest state is `warming` and the honest
   * action is to ask again. Every 3 s, up to 20 times, then the refusal's own copy.
   *
   * Remembers the marker first (`skinChosen`): from this call on, a seatless player is
   * `'joining'` and never `'select'`. Single-flight — it now has four callers, and two of
   * them are effects that React runs twice in development.
   */
  join(): Promise<void>;
  /**
   * Forget the marker and release any seat: the next screen is the character select.
   * The only way back to it once a seat has been taken, offered as a small link on the
   * results panel and on a failed rejoin — never as a step.
   */
  changeMarker(): Promise<void>;
  /**
   * `POST /api/match/start` — delegate, arm the crank and open the muster window.
   * 5–15 s of devnet round trips. Fired automatically by the first knight through the
   * gate (`App.tsx`'s `useMuster`), never by a button: the gate *is* the interaction.
   */
  startMatch(): Promise<void>;
  /** `POST /api/match/settle` — end the match and write the leaderboard. Retries by design. */
  settle(): Promise<void>;
  /** Owned by the subscription layer: one call per accepted notification. */
  setWorld(update: WorldUpdate): void;
  setStatus(status: ConnectionStatus, error?: string): void;
  /**
   * Release the seat, then take the next one.
   *
   * Async, and it tells the server. An abandoned raid used to strand its arena forever:
   * nothing on chain notices a player leaving, so the fight ran its full six minutes to
   * enrage and then sat in `SETTLING` with nobody left who was allowed to settle it.
   * Twelve of those made the game unjoinable. Telling the Worker at the moment of
   * departure is the fix; the request is best-effort because the local state must clear
   * whether or not the network answers.
   *
   * The `join` is inside rather than chained by each caller, and it WAITS for the leave:
   * a join fired alongside it races the Worker for a seat under the same identity in the
   * arena it is still leaving. Every caller — the verdict's countdown and button, Exit,
   * the void card's way out — wanted the same sequence, and the one that forgot the
   * `.then` would have left the player on the loader forever.
   */
  leaveMatch(): Promise<void>;

  /**
   * The JSON body of `/api/match/leave` for the held seat, for the closing-tab beacon —
   * or `null` when there is no seat or no proof can be had.
   *
   * Separate from `credentials()` because that one throws — correct everywhere else,
   * useless in a `pagehide` handler where there is nobody left to show an error to and
   * the page is already being destroyed. Never clears `authenticated` on failure for the
   * same reason: a tab being torn down must not decide the player is signed out.
   */
  leaveBeaconBody(): Promise<string | null>;

  /**
   * Disconnect the wallet and forget everything derived from it.
   *
   * There was no way to do this. `authenticated` had no setter — it was only ever cleared
   * implicitly when a token refresh failed while holding no seat, which never fires for a
   * player who simply wants a different wallet, because Privy keeps its own session alive
   * regardless of what the browser extension is connected to.
   *
   * Releases the seat first: a new Privy DID is a new on-chain identity and a new seat, so
   * switching without leaving would strand the old arena — the exact leak this release is
   * about, arrived at from a different direction.
   *
   * `logout` is the provider's own, and it runs BEFORE the store forgets. The landing
   * signs in whoever the provider still remembers (its returning-tab effect), so a store
   * that flipped first watched the same wallet sign itself straight back in — and, with a
   * marker on file, it would now take a seat. A guest has no provider and passes nothing.
   */
  signOut(logout?: () => Promise<void>): Promise<void>;
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
  }).catch(() => {
    // A `fetch` that never gets an answer rejects with the browser's own words, and the
    // three engines disagree: "Failed to fetch", "NetworkError when attempting to fetch
    // resource.", "Load failed". All three used to reach the error bar verbatim. One
    // sentence, engine-independent, and the only route failure a player can actually act on.
    throw new Error('The server could not be reached. Check your connection and try again.');
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
 * Route error codes, in the words a player can act on.
 *
 * Every `{ error: … }` the Worker can answer with is here — the five refusals of
 * `session/init` included, which is the set a failed seat claim draws from and the set
 * this map used to be missing. An uncovered code fell through `readable` verbatim, so
 * `no_open_arena` was printed as `no_open_arena`, 259 px from the button that had just
 * failed. The remaining gap is `index.ts`'s `BadRequest`, whose message is a validator's
 * own words (`skinId out of range`) and half of it interpolated (`missing or malformed
 * field: …`) — unkeyable, and unreachable from this client anyway, since every field it
 * validates comes from our own UI or from the Worker's own previous answer. Those land on
 * `UNKNOWN`, with the token kept in parentheses for a bug report.
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
  no_open_arena: 'The lobby is between arenas. The next one opens in a few seconds — try again.',
  try_again: 'The arena is changing hands. Try again in a moment.',
  no_such_match: 'That raid no longer exists. Take a new seat.',
  not_in_match: 'You do not hold a seat in that raid.',
  not_settleable: 'That raid has not finished yet.',
  unauthorized: 'Your sign-in has expired. Sign in again.',
  misconfigured: 'The backend is missing configuration and cannot start a raid.',
  not_found: 'The app asked for a route this server does not have. Reload the page.',
  internal_error: 'The server hit an error it did not expect. Try again.',
};

/**
 * The fallback, for a code no build of this client has heard of.
 *
 * Not the raw token any more. "An unfamiliar code is more useful than a reassuring lie"
 * was half right — it is more useful *to us* — but `no_such_match` on screen tells a
 * player neither what happened nor what to do, and every route in the Worker can produce
 * one. The sentence says what happened; the parenthesised token keeps everything the raw
 * form carried.
 */
const UNKNOWN = 'Something went wrong talking to the server. Try again in a moment.';

/** The raw route code `postJson` threw, before `MESSAGES` turns it into a sentence. */
function code(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readable(error: unknown): string {
  const raw = code(error);
  // Two populations reach here. The Worker's are machine-facing, lower-case by
  // construction — snake_case tokens, `http_502`, and `BadRequest`'s validator words.
  // Ours are already sentences and start with a capital. Sentence-casing is the whole
  // test, and it is the reason `settle`'s "The raid is taking an unusually long time"
  // does not come back wrapped in an apology about the server.
  return MESSAGES[raw] ?? (/^[a-z]/.test(raw) ? `${UNKNOWN} (${raw})` : raw);
}

/**
 * Refusals of `/api/session/init` that mean "not yet" rather than "no".
 *
 * `no_open_arena` is the scan finding nothing joinable while the next arena is still
 * being created; `try_again` is `routes.ts::preClaim` — the infrastructure before the
 * seat claim failed and nothing is half-done. Both are answered by asking again once the
 * background prewarm has landed. Everything else (`arena_full`, `treasury_low`, a 401)
 * is a fact a retry cannot change and reaches the error bar as before.
 */
const WARMING: ReadonlySet<string> = new Set(['no_open_arena', 'try_again']);

/**
 * 3 s × 20 is a minute of patience, and 20 requests a minute sits under the Worker's rate
 * limit of 30 per minute per IP per path (`index.ts`) — a faster loop would spend the
 * budget and turn `no_open_arena` into `rate_limited`.
 */
/** How long our seat must read empty before the match is treated as released. */
const SEAT_LOSS_MS = 1_500;
const WARM_RETRY_MS = 3_000;
const WARM_RETRIES = 20;

/**
 * Refusals of `/api/match/start` that mean the muster is open, just not by us.
 *
 * Every knight through the gate arms it and nineteen of twenty lose the race — that is
 * the design, not a failure, so none of these may reach the error bar. `no_raiders` is
 * the Worker's rendering of `HeartrotError::NoRaiders`, which `begin_muster` returns when
 * the chain has not yet seen anyone through the gate: our own zone flip arrived on a
 * notification, so a moment later it will have.
 *
 * Anything else *is* worth a line. A dry treasury presents as a raid that simply never
 * starts, and a player with no message assumes it is their wifi.
 */
const BENIGN_START: ReadonlySet<string> = new Set([
  'already_started',
  'match_in_progress',
  'no_raiders',
]);

// ---------------------------------------------------------------------------
// The marker on file
// ---------------------------------------------------------------------------

/**
 * The `skin_id` the last seat was taken with. Present means the select is done: a
 * reload, a new wallet, a guest coming back — none of them see it again. Cosmetic, so a
 * tampered value is the Worker's `skinId out of range` to refuse and the loader's
 * "Try again" / "Change marker" to recover from; only the shape is checked here.
 */
const SKIN_KEY = 'heartrot.skin';

function storedSkin(): number | null {
  try {
    const raw = localStorage.getItem(SKIN_KEY);
    const id = raw === null ? NaN : Number(raw);
    return Number.isInteger(id) && id >= 0 ? id : null;
  } catch {
    return null;
  }
}

/** `null` forgets. Storage that refuses (private mode, a blocked origin) is not an error:
 *  the marker then lasts the tab, which is exactly `skinChosen`. */
function storeSkin(skinId: number | null): void {
  try {
    if (skinId === null) localStorage.removeItem(SKIN_KEY);
    else localStorage.setItem(SKIN_KEY, String(skinId));
  } catch {
    // See above.
  }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** Statuses an incoming account update may not overwrite. See `setWorld`. */
const HELD: readonly ConnectionStatus[] = ['error', 'joining', 'settling'];

const INITIAL: State = {
  authenticated: false,
  guest: false,
  leaderboard: false,
  sessionKey: null,
  skinId: 0,
  skinChosen: false,
  seeking: false,
  classId: CLASS_ARCHER,
  match: null,
  status: 'idle',
  error: null,
  arena: null,
  boss: null,
  players: null,
  updatedAt: 0,
};

export function createStore(): Store {
  const stored = storedSkin();
  let state: State = stored === null ? INITIAL : { ...INITIAL, skinId: stored, skinChosen: true };
  const listeners = new Set<() => void>();

  // The settle route is deliberately safe to re-enter, but every client in a 20-player
  // raid sees `phase == Settling` on the same notification. Without this they all fire at
  // once and nineteen of them pay for a 25-second commit poll to learn nothing.
  let settling = false;
  // Same shape at the other end of the match: `start` spends ~0.0245 SOL of treasury rent
  // and takes 5–15 s, and a second call during it earns a 409 rather than a second raid.
  //
  // It no longer moves `status`. `joining` is in `HELD`, so an automatic call nobody
  // clicked would pin the connection dot on "joining" for fifteen seconds and stop the
  // world feed reporting itself live; `connecting` afterwards would report an already-live
  // feed as syncing. The visible answer to "did it take" is `fight_at_tick` counting down,
  // which is on chain and arrives by itself.
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

  /**
   * The identity half of every route body: a Privy token, or for a guest the session
   * key's signature over a fresh timestamped challenge (`guestProof`). Fresh per request
   * — the proof is good for five minutes and a request is never that old.
   */
  const identity = async (): Promise<{ privyToken: string } | { guest: GuestProof }> => {
    const { guest, sessionKey } = state;
    return guest && sessionKey
      ? { guest: await guestProof(sessionKey) }
      : { privyToken: await token() };
  };

  /** Every match route wants the identity and the arena id. One place to get both wrong. */
  const credentials = async (): Promise<Record<string, unknown>> => {
    const { match } = state;
    if (!match) throw new Error('no match joined');
    return { ...(await identity()), arenaId: match.arenaId };
  };

  /** Have we ever seen our own seat occupied? See `setWorld` for why this cannot be a
   * one-shot check against the first payload. */
  let seatHeld = false;
  /** When the held seat was first seen empty, or 0 while it is ours. See `setWorld`. */
  let seatMissingSince = 0;

  /**
   * The body of `/api/match/leave` for the held seat, or `null` when there is no seat or
   * no proof can be had. Reads the seat synchronously, so a caller that starts it and
   * only then clears the match still names the right arena.
   *
   * Never throws, and never clears `authenticated` on failure: one caller is a `pagehide`
   * handler with nobody left to show an error to, and a tab being torn down must not
   * decide the player is signed out.
   */
  const leaveBody = async (): Promise<Record<string, unknown> | null> => {
    const { match } = state;
    if (!match) return null;
    try {
      // `identity()`, not `authSource()` directly: a guest has no token to fetch, and
      // `token()` only clears `authenticated` when no seat is held — there is one here.
      return { ...(await identity()), arenaId: match.arenaId };
    } catch {
      return null;
    }
  };

  /**
   * Clear the local match and tell the Worker the seat is free.
   *
   * Shared by `leaveMatch`, `changeMarker` and `signOut`, because they are the same act
   * from the chain's point of view: this identity is done with this arena. Local state
   * clears first and unconditionally — the player is watching a screen change and must
   * never be stuck behind a devnet round trip. `proof` defaults to one fetched now;
   * `signOut` hands in one it fetched before the provider forgot it.
   */
  const release = async (proof = leaveBody()): Promise<void> => {
    settling = false;
    seatHeld = false;
    set({ match: null, arena: null, boss: null, players: null, status: 'idle', error: null });
    const body = await proof;
    if (body === null) return;
    await postJson('/api/match/leave', body).catch(() => {
      // Best effort by design. A failed release is the Worker's reaper to catch on the
      // next join, not an error to put in front of someone who has already left.
    });
  };

  // The latch. `signIn` and `playAsGuest` are fired from effects React double-invokes in
  // development, and the verdict's countdown and its button both want the same seat.
  let joining: Promise<void> | null = null;
  const join = (): Promise<void> =>
    (joining ??= claim().finally(() => {
      joining = null;
    }));

  const claim = async (): Promise<void> => {
    const { sessionKey, skinId, classId } = state;
    // On file before the request, not after it: the screen flips to the loader on
    // `skinChosen`, and the select must be gone the moment the seat is asked for.
    storeSkin(skinId);
    set({ status: 'joining', error: null, skinChosen: true, seeking: true });
    try {
      if (!sessionKey) throw new Error('Sign in before taking a seat.');
      for (let attempt = 0; ; attempt++) {
        try {
          const match = await postJson<MatchInfo>('/api/session/init', {
            ...(await identity()),
            sessionPubkey: sessionKey.address,
            skinId,
            classId,
          });
          // `connecting`, not `live`: a seat is not a subscription. The world stays null
          // until the sync layer has taken its `getMultipleAccounts` snapshot, because
          // subscribing alone delivers nothing until the next write.
          set({ match, status: 'connecting' });
          return;
        } catch (error) {
          if (attempt === WARM_RETRIES || !WARMING.has(code(error))) throw error;
        }
        set({ status: 'warming' });
        await new Promise((resolve) => setTimeout(resolve, WARM_RETRY_MS));
      }
    } catch (error) {
      fail(error);
    }
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
        set({ authenticated: true, guest: false, sessionKey, status: 'idle' });
      } catch (error) {
        fail(error);
        return;
      }
      // Identity only. Whether a seat follows is the caller's: the landing's Sign in
      // joins, the page-load restore of a Privy session does not (`seeking`).
    },

    async playAsGuest() {
      set({ status: 'joining', error: null });
      try {
        const sessionKey = await loadOrCreateSession();
        set({ authenticated: true, guest: true, sessionKey, status: 'idle' });
      } catch (error) {
        fail(error);
        return;
      }
      await join();
    },

    showLeaderboard() {
      set({ leaderboard: true });
    },

    hideLeaderboard() {
      set({ leaderboard: false });
    },

    setSkin(skinId) {
      set({ skinId });
    },

    join,

    async startMatch() {
      if (starting) return;
      starting = true;
      try {
        await postJson<unknown>('/api/match/start', await credentials());
      } catch (error) {
        if (!BENIGN_START.has(code(error))) fail(error);
      } finally {
        starting = false;
      }
    },

    async settle() {
      if (settling) return;
      settling = true;
      const held = state.match;
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
        // Only for the match still held. The verdict's countdown (or Exit) can release
        // the seat while this loop is mid-poll, and the route then answers `not_in_match`
        // for the OLD arena — `fail` would pin `error`, a held status the feed cannot
        // clear, over the NEW seat's live world.
        if (state.match === held) fail(error);
      } finally {
        settling = false;
      }
    },

    setWorld(update) {
      // The one place every account update lands, so the one place telemetry needs to
      // observe. `lastMoveSeq` on the local seat is what turns a fire-and-forget send
      // into a measurable round trip; without a seat there is throughput but no latency.
      //
      // Deliberately unclever, and it stays that way. At twenty seats this runs 714×/s
      // (measured), 68.4% of it carrying no change, every notification delivered twice by
      // the Magic Router — so the temptation is a diff here. Wrong layer: a decoded
      // account is a fresh object either way, so a store-side compare would be a deep one
      // over 20 slots and 128 bullets *and* would still have paid the 6.87 µs decode. The
      // drop belongs in `net/subscribe.ts`, on the base64 payload string, before the
      // decoder runs. Below that, `useSyncExternalStore` already keeps the blast radius to
      // the components whose selected value actually moved: only a selector returning a
      // whole account re-renders on every frame, and `App`'s `World` is the only one, by
      // design, because the renderer needs all three.
      if (state.match === null || update.from !== state.match.arenaPda) return;
      const seat = state.match.seat;
      const slot = update.players?.slots?.[seat];
      recordWorld(update.arena?.tick, slot?.lastMoveSeq);

      // Our seat is gone. Someone released it — another tab of ours pressing Exit, a
      // beacon from a window that closed, or the Worker's reaper — and the match we are
      // holding no longer has us in it.
      //
      // `seatHeld` is what makes this safe to act on. The ER offers no read-your-writes,
      // so the first `Players` payload after a join routinely predates the claim; treating
      // that as "released" would bounce every player straight back out of the seat they
      // just took. Only a seat we have *watched* be ours and then watched disappear is a
      // release. Without it the local match survives as a ghost: an archer nobody draws,
      // a HUD reading "down 0:00", and no way back to the character select.
      //
      // And it is judged over time, not on one payload: the seat must be missing for
      // `SEAT_LOSS_MS` of continuous updates, after the feed is live, before the match is
      // dropped. One stale roster is not a release; a second of them is.
      if (update.players) {
        if (slot?.occupied) {
          seatHeld = true;
          seatMissingSince = 0;
        } else if (seatHeld && state.status !== 'connecting' && state.status !== 'joining') {
          const now = performance.now();
          if (seatMissingSince === 0) seatMissingSince = now;
          else if (now - seatMissingSince >= SEAT_LOSS_MS) {
            seatHeld = false;
            seatMissingSince = 0;
            set({ match: null, arena: null, boss: null, players: null, status: 'idle' });
            // Seatless with a marker on file is `'joining'` (`screenOf`), and the loader
            // it shows would otherwise wait for a join nobody sends. Reclaiming is the
            // right answer to a reaped seat, and to another tab's Exit it is what that
            // tab is doing too.
            if (state.skinChosen) void join();
            return;
          }
        }
      }

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

    async leaveMatch() {
      await release();
      // `authenticated` is re-read: `token()` clears it when the leave's proof cannot be
      // had, and the landing — not the loader — is the honest screen for that.
      if (state.authenticated && state.skinChosen) await join();
    },

    async changeMarker() {
      storeSkin(null);
      set({ skinChosen: false, seeking: true });
      await release();
    },

    async leaveBeaconBody() {
      const body = await leaveBody();
      return body === null ? null : JSON.stringify(body);
    },

    async signOut(logout) {
      // The proof first, while the provider still answers; then the provider forgets;
      // then the store. See the `Store` doc for the order.
      const proof = leaveBody();
      await logout?.();
      // `guest` goes with it: the landing's "Play now" is the same offer again, while
      // "Sign in" makes the next raid a named one. The marker stays — it is the
      // browser's, and the next identity on it has no more to choose than this one did.
      set({ authenticated: false, guest: false, sessionKey: null, seeking: false });
      await release(proof);
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
  const slot = players.slots[match.seat] ?? null;
  // `occupied` is not decoration here. A seat that has been released — by Exit, by a
  // closing tab, or by the Worker's reaper — is zeroed on chain, and a zeroed slot answers
  // hp 0, zone LOBBY and class 0. Returned as if it were ours, that renders a player who
  // is dead, invisible and permanently at 0:00: every consumer reads plausible values and
  // none of them are about us. `null` is the honest answer to "which seat is mine" when
  // the answer is "none".
  return slot?.occupied ? slot : null;
}

/**
 * Where the player is, derived rather than stored.
 *
 * The lobby/arena split is `zone`, which only the chain writes: walking onto the gate tile
 * flips it, and the screen follows on the next notification. Nothing local decides it.
 *
 * Seatless splits on the marker: `'select'` only while no seat has ever been taken with
 * one, `'joining'` — the loader — from then on. The store keeps the second one honest by
 * joining wherever a seat is lost (`leaveMatch`, `signIn`, `setWorld`).
 */
export function screenOf(state: State): Screen {
  if (state.leaderboard) return 'leaderboard';
  if (!state.authenticated) return 'onboarding';
  if (!state.match) {
    if (!state.seeking) return 'onboarding';
    return state.skinChosen ? 'joining' : 'select';
  }
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
  // `occupied` is load-bearing: `mySeatSlot` answers null for a zeroed seat, and a fixture
  // without it read as "released" and sent the through-the-gate case to the lobby.
  const slot = (zone: number): PlayerSlot => ({ zone, occupied: true }) as PlayerSlot;
  const seated = (zone: number): Partial<State> => ({
    authenticated: true,
    match: { seat: 3 } as MatchInfo,
    players: { slots: [slot(0), slot(0), slot(0), slot(zone)] } as PlayersAccount,
  });

  const cases: readonly (readonly [string, Partial<State>, Screen])[] = [
    ['signed out', {}, 'onboarding'],
    ['leaderboard from the landing', { leaderboard: true }, 'leaderboard'],
    ['no seat, no marker yet, asked', { authenticated: true, seeking: true }, 'select'],
    // The rejoin: a marker on file makes seatless the loader, never the select again.
    ['no seat, marker on file, not asked', { authenticated: true, skinChosen: true }, 'onboarding'],
    ['no seat, marker on file, asked', { authenticated: true, skinChosen: true, seeking: true }, 'joining'],
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

  // `readable`'s branch. Its failure is silent in the same way: a machine token renders
  // as happily as a sentence does, and the bug is only visible to someone reading the
  // error bar at the moment a route refuses.
  // `string | undefined` is `noUncheckedIndexedAccess` on the `Record` lookups, and a
  // missing key is exactly what the first two cases exist to catch.
  const readableCases: readonly (readonly [string, string | undefined])[] = [
    ['arena_full', MESSAGES.arena_full],
    ['no_open_arena', MESSAGES.no_open_arena],
    ['skinId out of range', `${UNKNOWN} (skinId out of range)`],
    ['http_502', `${UNKNOWN} (http_502)`],
    ['Sign in before taking a seat.', 'Sign in before taking a seat.'],
  ];
  for (const [raw, expected] of readableCases) {
    const actual = readable(new Error(raw));
    if (actual !== expected) {
      throw new Error(`store self-check: readable('${raw}') got '${actual}'`);
    }
  }
}
