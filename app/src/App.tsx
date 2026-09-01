/**
 * The shell: four screens, one linear flow, no router — plus the two seams that make the
 * rest of `app/` reachable.
 *
 * Onboarding → character select → lobby → arena, and the only way back is a settled
 * match. A route table would buy history, deep links and code splitting for a flow with
 * no branches, no shareable URLs and one bundle — so the "route" is `screenOf(state)`,
 * which reads the seat's `zone` straight off the chain.
 *
 * This file draws the chrome (identity, the match clock, the result) and owns two things
 * nothing else can own, because nothing else sees both the store and the match:
 *
 *   **In** — `useMatchLink` pins the ER with `connectMatch`, opens `subscribeMatch` and
 *   feeds every account notification into `store.setWorld`. Without it `arena`, `boss` and
 *   `players` stay `null` for the life of the page and the world never moves.
 *
 *   **Out** — `World` attaches `attachControls` to the stage and turns each intent into a
 *   `move` / `shoot` / `enter_gate` signed by the session key and sent straight to the ER.
 *   This is the only path from a keypress to the chain; a Worker round trip here would
 *   throw away the entire reason for the rollup.
 *
 * The panels themselves live in `screens/` and `ui/Hud.tsx`, and the world is drawn by
 * `render/Arena.tsx`. They are imported, never re-implemented: a second copy of the part
 * list or the skin table drifts from the chain layout the moment either is touched.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  PHASE_LOBBY,
  PHASE_SETTLED,
  PHASE_SETTLING,
  ZONE_LOBBY,
  connectMatch,
  createSessionSigner,
  enterGate,
  movePlayer,
  sendInstructions,
  shoot,
  type HeartrotRpc,
  type SessionSigner,
} from '@heartrot/client';

import { attachControls } from './input/controls';
import { TILE, createPredictor, type Predictor } from './net/predict';
import { subscribeMatch, type MatchSubscription } from './net/subscribe';
import { Arena } from './render/Arena';
import { ARENA_UNITS } from './render/sprites';
import { CharacterSelect } from './screens/CharacterSelect';
import { Lobby } from './screens/Lobby';
import { Onboarding } from './screens/Onboarding';
import {
  mySeatSlot,
  screenOf,
  useSelect,
  useStore,
  type ConnectionStatus,
  type Screen,
} from './state/store';
import { Hud } from './ui/Hud';

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  idle: 'offline',
  joining: 'joining',
  connecting: 'syncing',
  live: 'live',
  stale: 'stalled',
  settling: 'settling',
  error: 'error',
};

/**
 * `Address` without importing `@solana/kit`: `app/package.json` does not depend on it
 * directly, and under pnpm's non-hoisted layout a bare import would not resolve here.
 * Same trick as `net/subscribe.ts`. The Worker hands these back as plain strings.
 */
type Addr = Parameters<HeartrotRpc['getAccountInfo']>[0];
const addr = (value: string): Addr => value as Addr;

/**
 * The gate tile block, mirrored from `GATE_MIN_X`..`GATE_MAX_Y` in
 * `programs/heartrot/src/handlers/player.rs`. There is no "enter the gate" button by
 * design — the gate is a place you walk to — so the client has to know where it is in
 * order to send `enter_gate` when the player arrives.
 *
 * ponytail: a second copy of a chain constant, like the wall ring in `net/predict.ts`.
 * Both retire together when the tilemap build step emits the map data for both sides;
 * until then a disagreement here costs a player who stands on the gate and never enters.
 */
const GATE_MIN = 30 * TILE;
const GATE_MAX = 34 * TILE - 1;

function onGate(x: number, y: number): boolean {
  return x >= GATE_MIN && x <= GATE_MAX && y >= GATE_MIN && y <= GATE_MAX;
}

/**
 * `enter_gate` is rejected silently while the chain still has you off the tile, and
 * gameplay is sent with `skipPreflight`, so a single attempt that loses the race is
 * invisible. Retry on this period until the seat's `zone` actually flips.
 */
const GATE_RETRY_MS = 500;

export default function App() {
  const screen = useSelect(screenOf);
  const phase = useSelect((s) => s.arena?.phase ?? PHASE_LOBBY);
  const status = useSelect((s) => s.status);
  const store = useStore();

  const link = useMatchLink();

  // The chain decides a match is over; somebody has to tell the base layer. `settle()`
  // is self-debouncing, so all twenty clients seeing this notification is fine.
  useEffect(() => {
    if (phase === PHASE_SETTLING && status !== 'settling') void store.settle();
  }, [phase, status, store]);

  return (
    <div className="shell">
      <Header />
      <main className="main">
        {screen === 'onboarding' && <Onboarding />}
        {screen === 'select' && <CharacterSelect />}
        {screen === 'lobby' && <Lobby />}
        {screen === 'arena' && <ArenaScreen />}
      </main>
      <World screen={screen} link={link} />
      <ErrorBar />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function Header() {
  const status = useSelect((s) => s.status);
  const seat = useSelect((s) => s.match?.seat ?? null);
  const incarnation = useSelect((s) => s.match?.incarnation ?? 0);
  const tick = useSelect((s) => s.arena?.tick ?? 0);

  return (
    <header className="header">
      <h1 className="wordmark">HEARTROT</h1>
      <span className="tag">incarnation {incarnation}</span>
      {seat !== null && <span className="tag">seat {seat}</span>}
      <span className="spacer" />
      <span className="tag tabular">tick {tick}</span>
      <span className={`dot dot-${status}`} aria-hidden="true" />
      <span className="tag">{STATUS_LABEL[status]}</span>
    </header>
  );
}

/**
 * Errors are shown, never swallowed. A stalled crank and a dry treasury both present as
 * "nothing is happening", and a player with no message assumes the former is their wifi.
 */
function ErrorBar() {
  const error = useSelect((s) => s.error);
  const status = useSelect((s) => s.status);
  if (!error && status !== 'stale') return null;
  return (
    <div className="errorbar" role="status">
      {error ?? 'The boss clock has stopped advancing. Waiting for the rollup to answer.'}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen 4 — arena
//
// Named `ArenaScreen`, not `Arena`: `render/Arena` is the renderer and this is the panel
// beside it. Screens 1–3 are `screens/*`; the arena's panel is `ui/Hud`, so all this
// screen owns is the stage node and the layout around it.
// ---------------------------------------------------------------------------

function ArenaScreen() {
  const phase = useSelect((s) => s.arena?.phase ?? PHASE_LOBBY);

  return (
    <>
      {/* The renderer's territory — see `World`. React never touches what is inside it. */}
      <div id="stage" className="stage" role="presentation" />
      <aside className="panel">
        <Hud />
      </aside>
      {phase === PHASE_SETTLED && <Result />}
    </>
  );
}

/** The match is over and the leaderboard row is written. Nothing here is on chain twice. */
function Result() {
  const store = useStore();
  const slot = useSelect(mySeatSlot);
  const coreHp = useSelect((s) => s.boss?.coreHp ?? 0);
  const won = coreHp === 0;

  return (
    <div className="overlay">
      <div className="card">
        <p className="eyebrow">{won ? 'The core stopped' : 'The raid broke'}</p>
        <h2>{won ? 'It is dead. It will be back, larger.' : 'Wiped.'}</h2>
        <p className="lede tabular">
          {slot ? `${slot.damageDealt} damage dealt · ${slot.hp === 0 ? 'died' : 'survived'}` : ''}
        </p>
        <p className="fine">
          The arena has been committed back to the base layer and your row is on the
          leaderboard. The next incarnation has fifteen percent more shell per part.
        </p>
        <button className="btn btn-primary" onClick={() => store.leaveMatch()}>
          Back to the lobby
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The world, and the way out of it
// ---------------------------------------------------------------------------

/**
 * Draws the scene into whichever screen currently owns `#stage`, and binds input to it.
 *
 * A portal rather than a child, because the two screens that have a stage declare it
 * themselves — `screens/Lobby.tsx` owns the lobby's node — and duplicating the id here to
 * host the renderer would put two `#stage` elements in the document. One portal covers
 * both screens and the id stays declared exactly once.
 */
function World({ screen, link }: { screen: Screen; link: Link }) {
  const host = useStageHost(screen);
  const arena = useSelect((s) => s.arena);
  const boss = useSelect((s) => s.boss);
  const players = useSelect((s) => s.players);
  const seat = useSelect((s) => s.match?.seat ?? -1);
  const tickMs = useSelect((s) => s.match?.tickMs ?? 400);

  useGameplay(host, link);

  if (!host || !arena || !boss || !players) return null;

  // `.hr-stage` sizes itself from its parent, and a portal's parent is the stage cell:
  // this grid box is what gives it one, so `usePixelFit` has a rect to measure.
  return createPortal(
    <div style={{ position: 'absolute', inset: 0, display: 'grid' }}>
      <Arena arena={arena} boss={boss} players={players} localSeat={seat} tickMs={tickMs} />
    </div>,
    host,
  );
}

/**
 * The `#stage` node of the screen that is currently mounted, or `null` on the two screens
 * that have none. Keyed on the screen because that is exactly when the node is replaced;
 * re-reading the same element is a no-op, so this settles in one pass.
 */
function useStageHost(screen: Screen): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHost(document.getElementById('stage'));
  }, [screen]);
  return host;
}

/**
 * Input → transaction. The only place in the app that signs anything.
 *
 * Every send is fire-and-forget: `sendInstructions` uses `skipPreflight` by design, so
 * awaiting a confirmation on the hot path would cost a round trip per keypress and still
 * not prevent anything. A rejected move is corrected by the next reconcile, which is what
 * the prediction buffer is for.
 */
function useGameplay(host: HTMLElement | null, link: Link): void {
  const store = useStore();

  useEffect(() => {
    if (host === null || link === null) return;
    const { er, signer, predictor, match } = link;
    const session = signer.address;
    const common = { programId: match.programId, arena: match.arena, players: match.players };

    const send = (instruction: Parameters<typeof sendInstructions>[2][number]): void => {
      void sendInstructions(er, signer, [instruction]).catch((error: unknown) => {
        // Not `setStatus('error')`: that is a held status the world feed cannot clear, and
        // one dropped datagram out of ten a second must not brick the session. The
        // watchdog in `subscribe.ts` is what reports a feed that has actually stopped.
        console.error('heartrot: gameplay send failed', error);
      });
    };

    let lastGateAt = Number.NEGATIVE_INFINITY;
    const maybeEnterGate = (): void => {
      const slot = mySeatSlot(store.getState());
      if (!slot || slot.zone !== ZONE_LOBBY) return;
      if (!onGate(predictor.self.x, predictor.self.y)) return;
      const now = performance.now();
      if (now - lastGateAt < GATE_RETRY_MS) return;
      lastGateAt = now;
      send(enterGate({ ...common, session, seat: match.seat }));
    };

    return attachControls({
      surface: host,
      // Read live rather than captured: the gates mirror `arena.tick`, and a stale clock
      // here would rate-limit against a tick that passed seconds ago.
      clock: () => {
        const { arena } = store.getState();
        return { phase: arena?.phase ?? PHASE_LOBBY, tick: arena?.tick ?? 0 };
      },
      aimOrigin: () => {
        const svg = host.querySelector('svg');
        if (svg === null) return null;
        const box = svg.getBoundingClientRect();
        if (box.width === 0) return null;
        const scale = box.width / ARENA_UNITS;
        return {
          x: box.left + predictor.self.x * scale,
          y: box.top + predictor.self.y * scale,
        };
      },
      onMove: (dir) => {
        // `push` returns `null` when the chain would reject the move anyway — a wall, or a
        // dead player — and sending it then would burn a slot in the one-move-per-tick
        // budget on a transaction that cannot land. It also applies the same `MOVE_STEP`
        // the handler indexes with `dir`, so the predicted step and the chain's are one
        // table and cannot disagree.
        const seq = predictor.push(dir);
        if (seq === null) return;
        send(movePlayer({ ...common, session, seat: match.seat, dir, seq }));
        maybeEnterGate();
      },
      onShoot: (dir) => {
        send(shoot({ ...common, boss: match.boss, session, seat: match.seat, dir }));
      },
    });
  }, [host, link, store]);
}

// ---------------------------------------------------------------------------
// The world feed
// ---------------------------------------------------------------------------

/** Everything the gameplay path needs, resolved once per match. */
type Link = {
  readonly er: HeartrotRpc;
  readonly signer: SessionSigner;
  readonly predictor: Predictor;
  readonly match: {
    readonly seat: number;
    readonly programId: Addr;
    readonly arena: Addr;
    readonly boss: Addr;
    readonly players: Addr;
  };
} | null;

/**
 * Pin the ER, subscribe to the three accounts, and push every update into the store.
 *
 * The subscription is deliberately keyed on `match` alone and not on the screen: the
 * lobby↔arena transition must not tear it down, because the measured reconnect outage is
 * ~1.7 s and in a bullet-hell fight that is a death and a visible teleport.
 */
function useMatchLink(): Link {
  const store = useStore();
  const match = useSelect((s) => s.match);
  const session = useSelect((s) => s.sessionKey);
  const [link, setLink] = useState<Link>(null);

  useEffect(() => {
    if (match === null || session === null) {
      setLink(null);
      return;
    }

    let cancelled = false;
    let subscription: MatchSubscription | null = null;
    const predictor = createPredictor();
    const accounts = {
      arena: addr(match.arenaPda),
      boss: addr(match.bossPda),
      players: addr(match.playersPda),
    };

    void (async () => {
      try {
        // `baseUrl` is only used for the base-layer handle this client never touches —
        // the ER itself is resolved from the router by `validatorIdentity`, which is the
        // one thing that must never be guessed: the wrong ER answers with correctly-owned,
        // silently frozen data.
        const { er } = await connectMatch({
          baseUrl: match.erEndpoint,
          routerUrl: match.routerEndpoint,
          accounts: [accounts.arena, accounts.boss, accounts.players],
          validatorIdentity: addr(match.validatorIdentity),
          ownerProgram: addr(match.programId),
        });
        if (cancelled) return;

        subscription = subscribeMatch({
          rpc: er,
          ...accounts,
          onArena: (arena) => store.setWorld({ arena }),
          onBoss: (boss) => store.setWorld({ boss }),
          onPlayers: (players) => {
            store.setWorld({ players });
            const slot = players.slots[match.seat];
            // The reconcile is what drains the prediction buffer. Without it every input
            // replays forever and the local knight walks away from the server's copy.
            if (slot !== undefined) predictor.reconcile(slot);
          },
          onHealth: (health) => {
            // `live` and `connecting` are already carried by `setWorld` and `join`, and
            // writing them here would stomp the held statuses the player is waiting on.
            if (health === 'stalled') store.setStatus('stale');
            // `Arena.tick` is the only crank-liveness signal there is; a dead one means
            // the scheduled task is gone and the match has to be settled from outside.
            if (health === 'dead') void store.settle();
          },
        });

        setLink({
          er,
          signer: createSessionSigner(session),
          predictor,
          match: {
            seat: match.seat,
            programId: addr(match.programId),
            arena: accounts.arena,
            boss: accounts.boss,
            players: accounts.players,
          },
        });
      } catch (error) {
        if (cancelled) return;
        // Fatal for this match: no ER means no world and no gameplay, and a silent retry
        // loop would look exactly like a frozen game.
        store.setStatus('error', error instanceof Error ? error.message : String(error));
      }
    })();

    return () => {
      cancelled = true;
      subscription?.close();
      setLink(null);
    };
  }, [match, session, store]);

  return link;
}

// ---------------------------------------------------------------------------
// Self-check
//
// The gate block is a copy of a chain constant, and a wrong copy fails the way a copy
// always does: the player stands on the gate, `enter_gate` is never sent or never
// accepted, and the raid simply never starts. Dev-only.
// ---------------------------------------------------------------------------

if (import.meta.env.DEV) {
  const corners: readonly (readonly [number, number, boolean])[] = [
    [GATE_MIN, GATE_MIN, true],
    [GATE_MAX, GATE_MAX, true],
    [GATE_MIN - 1, GATE_MIN, false],
    [GATE_MAX + 1, GATE_MAX, false],
    [GATE_MIN, GATE_MAX + 1, false],
  ];
  for (const [x, y, expected] of corners) {
    if (onGate(x, y) !== expected) {
      throw new Error(`App self-check: onGate(${x}, ${y}) should be ${String(expected)}`);
    }
  }
  // 30..34 tiles inclusive-exclusive, exactly as `player.rs` writes it.
  if (GATE_MIN !== 480 || GATE_MAX !== 543) {
    throw new Error(`App self-check: gate block is ${GATE_MIN}..${GATE_MAX}, expected 480..543`);
  }
}
