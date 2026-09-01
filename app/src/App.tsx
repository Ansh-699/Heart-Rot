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
  MAP_TILE,
  MAP_TILES,
  PHASE_LOBBY,
  PHASE_SETTLED,
  PHASE_SETTLING,
  ZONE_LOBBY,
  confirmSignature,
  connectMatch,
  createSessionSigner,
  decodeTransactionError,
  enterGate,
  movePlayer,
  sendInstructions,
  shoot,
  type HeartrotRpc,
  type SessionSigner,
} from '@heartrot/client';

import { attachControls } from './input/controls';
import { recordSend } from './net/metrics';
import DevPanel from './ui/DevPanel';
import { GATE_MAX, GATE_MIN } from './render/sprites';
import { createPredictor, type Predictor } from './net/predict';
import { subscribeMatch, type MatchSubscription } from './net/subscribe';
import { Arena } from './render/Arena';
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
 * The arena's own coordinate space, straight from the generated map table — not from
 * `render/sprites`. The renderer is free to be an `<svg>`, a `<canvas>` or a pile of
 * `<div>`s, and this file has no business knowing which; what it needs is the number both
 * ends agree the world is measured in, and `tools/gen_map.py` emits that for both sides.
 */
const ARENA_UNITS = MAP_TILES * MAP_TILE;

/**
 * The gate tile block, mirrored from `GATE_MIN_X`..`GATE_MAX_Y` in
 * `programs/heartrot/src/handlers/player.rs`. There is no "enter the gate" button by
 * design — the gate is a place you walk to — so the client has to know where it is in
 * order to send `enter_gate` when the player arrives.
 *
 * The numbers live in `render/sprites.ts` because the renderer has to draw the same block
 * it fires on — two copies is how the marker ends up somewhere the gate is not.
 *
 * ponytail: still a second copy of a chain constant, like the wall ring in
 * `net/predict.ts`. Both retire together when the tilemap build step emits the map data
 * for both sides; until then a disagreement costs a player who stands on the gate and
 * never enters.
 */
function onGate(x: number, y: number): boolean {
  return x >= GATE_MIN && x <= GATE_MAX && y >= GATE_MIN && y <= GATE_MAX;
}

/**
 * `enter_gate` is rejected silently while the chain still has you off the tile, and
 * gameplay is sent with `skipPreflight`, so a single attempt that loses the race is
 * invisible. Retry on this period until the seat's `zone` actually flips.
 */
const GATE_RETRY_MS = 500;

/** How long a refused-instruction line stays in the error bar. */
const NOTICE_MS = 2_500;

export default function App() {
  const screen = useSelect(screenOf);
  const phase = useSelect((s) => s.arena?.phase ?? PHASE_LOBBY);
  const status = useSelect((s) => s.status);
  const store = useStore();

  const link = useMatchLink();
  // Not inside `World`: the gate is what gets you *out* of the lobby, and it must keep
  // running on a screen whose stage node the renderer has not attached to yet.
  useGateEntry(link);

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
      <DevPanel />
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
      {/* Two clusters, not five loose tags: what match this is on the left, how it is
          running on the right. Tight gaps inside a cluster and a wide one between them
          do the grouping, so nothing needs a divider. */}
      <div className="header-group">
        <span className="tag">incarnation {incarnation}</span>
        {seat !== null && <span className="tag">seat {seat}</span>}
      </div>
      <span className="spacer" />
      <div className="header-group">
        <span className="tag tabular">tick {tick}</span>
        <span className={`dot dot-${status}`} aria-hidden="true" />
        <span className="tag">{STATUS_LABEL[status]}</span>
      </div>
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
  const tickMs = useSelect((s) => s.match?.tickMs ?? 100);

  useGameplay(host, link);

  if (!host || !arena || !boss || !players) return null;

  // `.hr-stage` sizes itself from its parent, and a portal's parent is the stage cell:
  // this grid box is what gives it one, so `usePixelFit` has a rect to measure.
  return createPortal(
    <div style={{ position: 'absolute', inset: 0, display: 'grid' }}>
      {/* `predictor` is what lets the renderer draw the local seat from prediction instead
          of from `useSeatInterpolation`. Interpolation lerps between *authoritative*
          snapshots, and once the boss activates `boss_tick` rewrites `Players` every 100 ms
          for collisions and respawns — most of those carry no position change — so the
          local seat lerps P→P, holds, then jumps when a real move lands. Prediction is
          driven by input and cannot be re-anchored by a crank write. Remote seats keep
          interpolating; they have no input to predict from.

          `undefined` until `useMatchLink` resolves, which `Arena` reads as "interpolate
          every seat" — the prop is optional and deliberately not `| null`, so this is the
          one absent value it accepts. Same object `aimOrigin` reads below, so the pointer
          aims at the dot the player is actually looking at rather than at a position 127 ms
          behind it. */}
      <Arena
        arena={arena}
        boss={boss}
        players={players}
        localSeat={seat}
        tickMs={tickMs}
        predictor={link?.predictor}
      />
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

    // A transient line in the error bar. `setStatus(currentStatus, message)` writes the
    // message without moving the status, so the connection dot stays honest and the world
    // feed keeps clearing it — an unclearable 'error' status over a rejected datagram is
    // exactly the brick this avoids.
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;
    const notice = (message: string): void => {
      store.setStatus(store.getState().status, message);
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => {
        if (store.getState().error === message) store.setStatus(store.getState().status);
      }, NOTICE_MS);
    };

    // `sendInstructions` runs `skipPreflight`, so a refused instruction returns a
    // signature and then fails in silence — a player who is rate-limited or dead sees
    // their dot simply not move and has no way to learn why. One confirm at a time
    // samples that: `RateLimited` and `PlayerDead` are conditions that repeat every
    // tick, so a sample catches them within a tick or two.
    //
    // ponytail: one outstanding confirm per client, ~2 status polls a second. Confirm
    // every send if a one-off rejection ever needs to be attributed exactly.
    let confirming = false;

    const send = (instruction: Parameters<typeof sendInstructions>[2][number]): void => {
      void sendInstructions(er, signer, [instruction])
        .then(async (signature) => {
          if (confirming) return;
          confirming = true;
          try {
            await confirmSignature(er, signature, { timeoutMs: 2_000, pollMs: 400 });
          } finally {
            confirming = false;
          }
        })
        .catch((error: unknown) => {
          // `decodeTransactionError`, never a hand-rolled parse: the ER writes
          // `InstructionError` members as JSON strings where base devnet writes numbers
          // and kit hands back bigints, and only this decoder reads all three.
          const decoded = decodeTransactionError(
            error instanceof Error && error.cause !== undefined ? error.cause : error,
          );
          // `BlockedByWall` is expected traffic — one per tick from anyone holding a
          // direction into a wall — and a timeout is the ER being slow, not a refusal.
          if (decoded.code === 14 || decoded.code === undefined) return;
          // Not `setStatus('error')`: that status is held and the world feed cannot clear
          // it, so one refused datagram out of ten a second would brick the session. The
          // watchdog in `subscribe.ts` is what reports a feed that has actually stopped.
          notice(`${decoded.name ?? `Custom(${decoded.code})`} — ${decoded.message}`);
        });
    };

    const detach = attachControls({
      surface: host,
      // Read live rather than captured: the gates mirror `arena.tick`, and a stale clock
      // here would rate-limit against a tick that passed seconds ago. `alive` stops a
      // downed player spending the whole respawn window sending shots the chain answers
      // with PlayerDead.
      clock: () => {
        const { arena } = store.getState();
        const slot = mySeatSlot(store.getState());
        return {
          phase: arena?.phase ?? PHASE_LOBBY,
          tick: arena?.tick ?? 0,
          alive: slot === null || slot.hp > 0,
        };
      },
      aimOrigin: () => {
        // Whichever drawing surface the renderer chose. Its box is the arena square, so
        // its width is the scale; `null` when there is none yet, which `attachControls`
        // reads as "keep the last facing" rather than as an aim at the origin.
        const surface = host.querySelector('svg, canvas');
        if (surface === null) return null;
        const box = surface.getBoundingClientRect();
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
        // Recorded before the send, so a transaction that never resolves still counts as
        // in flight and ages into the unacked bucket rather than vanishing.
        recordSend(seq);
        send(movePlayer({ ...common, session, seat: match.seat, dir, seq }));
      },
      onShoot: (dir) => {
        // No `seq` on the wire for `shoot`, so it counts toward throughput and never
        // toward latency. Inventing a round trip for it would be a made-up number.
        recordSend();
        send(shoot({ ...common, boss: match.boss, session, seat: match.seat, dir }));
      },
    });

    return () => {
      clearTimeout(noticeTimer);
      detach();
    };
  }, [host, link, store]);
}

/**
 * Walking onto the gate is what starts the raid, so the check has to run off the
 * **chain's** copy of the player and not off an input callback.
 *
 * The old version fired inside `onMove`, one line after the `movePlayer` that put the
 * player on the tile: under `skipPreflight` the chain still had them off the gate, the
 * `enter_gate` was rejected invisibly, and a player who then stopped pressing keys
 * produced no further `onMove` — no retry, stuck in the lobby for the life of the match.
 *
 * So: poll the authoritative slot. `mySeatSlot` is whatever the last `Players`
 * notification wrote, which is exactly the state the handler will check, and standing
 * still keeps satisfying it. The loop stops itself the moment `zone` flips out of
 * `ZONE_LOBBY` — the same one-way condition the handler enforces — and `inFlight` keeps
 * a slow send from being sent twice.
 */
function useGateEntry(link: Link): void {
  const store = useStore();

  useEffect(() => {
    if (link === null) return;
    const { er, signer, match } = link;
    let inFlight = false;

    const timer = setInterval(() => {
      if (inFlight) return;
      const slot = mySeatSlot(store.getState());
      if (!slot || slot.zone !== ZONE_LOBBY) return;
      if (!onGate(slot.x, slot.y)) return;
      inFlight = true;
      void sendInstructions(er, signer, [
        enterGate({
          programId: match.programId,
          arena: match.arena,
          players: match.players,
          session: signer.address,
          seat: match.seat,
        }),
      ])
        .catch((error: unknown) => {
          // Same reasoning as the gameplay path: a dropped send is retried on the next
          // period, and holding `error` here would hide the world feed behind it.
          console.error('heartrot: enter_gate send failed', error);
        })
        .finally(() => {
          inFlight = false;
        });
    }, GATE_RETRY_MS);

    return () => {
      clearInterval(timer);
    };
  }, [link, store]);
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
            //
            // Unconditional, and it stays that way. In a fight this runs ~10/s on crank
            // writes that advance nothing, which looks like the thing to gate on
            // `lastMoveSeq` — it is not. A reconcile with no ack replays the buffer from
            // the same authoritative position and is exactly idempotent: measured 178
            // no-ack reconciles over a 30 s fight moved `self` zero units, and 50 of them
            // back to back against a 10-deep buffer left the position bit-identical. Cost
            // is 643 ns on a saturated 32-deep buffer, ~6 µs per wall-clock second. Gating
            // it would buy nothing and would drop the TTL sweep that retires a silently
            // refused move, which is a real desync.
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
