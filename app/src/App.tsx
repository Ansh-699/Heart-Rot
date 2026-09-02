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
 *   **Through** — `useGateEntry` then `useMuster`: standing on the gate sends
 *   `enter_gate`, and the seat's own `zone` flipping arms the muster. There is no button
 *   at either end, and both watch the chain's copy of the player rather than an input
 *   callback, because the version that fired from `onMove` stranded players permanently.
 *
 * The 320 px side panel is gone (`17-fullscreen-spec.md` §9.1) and the scene fills the
 * stage edge to edge, so the chrome is `ui/Hud.tsx`'s fixed clusters, mounted once here
 * for both sides of the gate. `screens/Lobby.tsx` is down to the one line of instruction
 * that is genuinely the waiting room's. The world is drawn by `render/Passage.tsx`, which
 * is `render/Arena.tsx` wrapped in the gate beat. All of it is imported, never
 * re-implemented: a second copy of the part list or the skin table drifts from the chain
 * layout the moment either is touched.
 */

import { useEffect, useReducer, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  PHASE_FIGHTING,
  PHASE_LOBBY,
  PHASE_MUSTERING,
  PHASE_SETTLED,
  PHASE_SETTLING,
  ZONE_ARENA,
  ZONE_LOBBY,
  classOf,
  confirmSignature,
  connectMatch,
  createSessionSigner,
  decodeTransactionError,
  enterGate,
  movePlayer,
  onGate,
  sendInstructions,
  shoot,
  type HeartrotRpc,
  type SessionSigner,
} from '@heartrot/client';

import { attachControls } from './input/controls';
import { recordSend } from './net/metrics';
import DevPanel from './ui/DevPanel';
import { createPredictor, type Predictor } from './net/predict';
import { subscribeMatch, type MatchSubscription } from './net/subscribe';
import { Passage } from './render/Passage';
import { fireLocal } from './render/Shot';
import { CharacterSelect } from './screens/CharacterSelect';
import { Lobby } from './screens/Lobby';
import { Onboarding } from './screens/Onboarding';
import { mySeatSlot, screenOf, useSelect, useStore } from './state/store';
import { Hud } from './ui/Hud';

/**
 * `Address` without importing `@solana/kit`: `app/package.json` does not depend on it
 * directly, and under pnpm's non-hoisted layout a bare import would not resolve here.
 * Same trick as `net/subscribe.ts`. The Worker hands these back as plain strings.
 */
type Addr = Parameters<HeartrotRpc['getAccountInfo']>[0];
const addr = (value: string): Addr => value as Addr;

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

  /**
   * The one `#stage` node, owned here rather than by the two screens that show it.
   *
   * It used to be declared twice — once in `screens/Lobby.tsx`, once in the arena screen
   * — and `World` portalled into whichever one was mounted. React reconciles a portal on
   * container *identity*, so walking through the gate swapped the container and the whole
   * arena was deleted and rebuilt: `SCENE` (16 paths, 332 KB of path data, 46.3 ms to
   * build), the knight pose defs, the boss art, every walk odometer, both rAF loops, the
   * ResizeObserver and the camera — on the single most important transition in the game.
   * Declared once, at a fixed position in `<main>`'s children, the node survives the flip
   * and React swaps nothing around it. Any restructure of `<main>`'s children must keep
   * this slot where it is; remounting it costs 46.3 ms of scene rebuild.
   *
   * A ref, not `getElementById` in an effect: refs are attached in the commit phase, so
   * the portal has its host in the same paint the node appears in rather than one frame
   * later. `hasStage` is a separate child slot, so lobby↔arena never changes its position.
   */
  const [stage, setStage] = useState<HTMLElement | null>(null);
  const hasStage = screen === 'lobby' || screen === 'arena';

  /**
   * The resync gate (spec §7.2), bumped whenever the world feed leaves `'live'`.
   *
   * Every diff-triggered cinematic downstream — the passage, the spawn — resets its
   * baseline on a change here, because the renderer does **not** unmount across the
   * measured 1,681 ms reconnect: without this a player who drops in the waiting room and
   * returns in the pit replays the gate beat over a fight already in progress.
   *
   * `useReducer` for the stable dispatch, so `useMatchLink`'s effect does not re-subscribe
   * when it fires. **Never derive this from `state.status`** — `store.ts` forces that to
   * `'live'` on every payload, so the gate would race the thing it gates.
   *
   * ponytail: local to the shell rather than a store field, because `state/store.ts` is
   * not this change's to edit. Move it there when the two readers stop being the shell's
   * own children.
   */
  const [feedEpoch, bumpFeedEpoch] = useReducer((n: number) => n + 1, 0);

  const link = useMatchLink(bumpFeedEpoch);
  // Not inside `World`: the gate is what gets you *out* of the lobby, and it must keep
  // running on a screen whose stage node the renderer has not attached to yet.
  useGateEntry(link);
  useMuster();

  // The chain decides a match is over; somebody has to tell the base layer. `settle()`
  // is self-debouncing, so all twenty clients seeing this notification is fine.
  useEffect(() => {
    if (phase === PHASE_SETTLING && status !== 'settling') void store.settle();
  }, [phase, status, store]);

  return (
    <div className="shell">
      <Header />
      <main className="main">
        {/* The renderer's territory, and now the whole of the main row — see `World`.
            React never touches what is inside it. */}
        {hasStage && <div id="stage" className="stage" role="presentation" ref={setStage} />}
        {screen === 'onboarding' && <Onboarding />}
        {screen === 'select' && <CharacterSelect />}
        {screen === 'lobby' && <Lobby />}
      </main>
      <World host={hasStage ? stage : null} link={link} feedEpoch={feedEpoch} />
      {/* One HUD, both sides of the gate. Its clusters are `position: fixed`, so they are
          mounted once here rather than by each screen — which is also what finally puts a
          shot indicator in the waiting area, the one screen the dead spacebar lived on
          (spec §9.2). */}
      {hasStage && <Hud />}
      {/* `hasStage`, not `screen === 'arena'`: a seat that never crossed the gate is still
          in the match the chain just settled, and gating this on the arena screen left
          that player on `GatePrompt`'s "Hold here" forever with no verdict and no button —
          `leaveMatch` has no other caller in the app. The card is the way out for both
          sides of the gate. */}
      {hasStage && phase === PHASE_SETTLED && <Result />}
      <ErrorBar />
      <DevPanel />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

/**
 * The wordmark, and nothing else.
 *
 * Spec §9.1 keeps the 48 px bar — the wordmark is a branding decision the user has not
 * made — but every number that used to sit beside it (phase, tick, seat, socket) is now
 * `Hud`'s top-left cluster. Two copies of the tick, one 48 px above the other, is this
 * repo's named defect in its smallest possible form.
 */
function Header() {
  return (
    <header className="header">
      <h1 className="wordmark">HEARTROT</h1>
    </header>
  );
}

/**
 * Errors are shown, never swallowed. A stalled crank and a dry treasury both present as
 * "nothing is happening", and a player with no message assumes the former is their wifi.
 *
 * Third source, same bar: the class the chain actually gave you. `claim_seat`'s returning
 * branch rotates `session_pubkey` and `skin_id` and deliberately **not** `class` — a
 * rotation would let a player fire the archer's 70 and take the next shot on the knight's
 * 800 ms — and it returns `Ok`, so a returning identity that picked the other weapon is
 * told nothing at all today. The chain is right and is not in scope; this is the sentence
 * that was missing. It names no class on purpose: `Hud`'s bottom-left pill already reads
 * the seat's own byte, and a second class-name table here is the repo's signature defect.
 */
function ErrorBar() {
  const error = useSelect((s) => s.error);
  const status = useSelect((s) => s.status);
  // A primitive, so the bar does not re-render on every `Players` notification that
  // leaves the answer unchanged.
  const keptOldClass = useSelect((s) => {
    const slot = mySeatSlot(s);
    return slot !== null && slot.occupied && classOf(slot) !== s.classId;
  });

  const message =
    error ??
    (status === 'stale'
      ? 'The boss clock has stopped advancing. Waiting for the rollup to answer.'
      : keptOldClass
        ? 'Your seat already existed, so it kept the weapon it was claimed with — the class shown bottom-left is the one you are fighting with. A seat cannot change class mid-raid; the next one takes your new pick.'
        : null);

  if (message === null) return null;
  return (
    <div className="errorbar" role="status">
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen 4 — arena
//
// There is no `ArenaScreen` any more. It was the 320 px panel and the result card; the
// panel is deleted (spec §9.1) and `Hud`'s fixed clusters replace it on both sides of the
// gate, so the only thing left was one conditional render and `App` already holds both
// values it tested.
// ---------------------------------------------------------------------------

/**
 * The match is over and the leaderboard row is written. Nothing here is on chain twice.
 *
 * Shown on both sides of the gate, so the line under the verdict has to be honest about a
 * seat that never left the waiting room: `0 damage dealt · survived` reads as a fight that
 * went badly rather than a match that was never joined.
 */
function Result() {
  const store = useStore();
  const slot = useSelect(mySeatSlot);
  const coreHp = useSelect((s) => s.boss?.coreHp ?? 0);
  const won = coreHp === 0;
  const watched = slot !== null && slot.zone === ZONE_LOBBY;

  return (
    <div className="overlay">
      <div className="card">
        <p className="eyebrow">{won ? 'The core stopped' : 'The raid broke'}</p>
        <h2>{won ? 'It is dead. It will be back, larger.' : 'Wiped.'}</h2>
        <p className="lede tabular">
          {slot === null
            ? ''
            : watched
              ? 'You watched this one from the waiting room — the gate is open from the first tick of the next raid.'
              : `${slot.damageDealt} damage dealt · ${slot.hp === 0 ? 'died' : 'survived'}`}
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
 * Draws the scene into `#stage`, and binds input to it.
 *
 * A portal rather than a child so that this component — and only this component — carries
 * the three subscriptions that fire 10-20 times a second. Inlining the tree into `App`
 * would re-render the header, the HUD and the error bar at notification rate for a
 * subtree that is drawn by the frame loop anyway.
 *
 * `host` is `App`'s single stage node and never changes identity between the lobby and
 * the arena, which is what keeps the portal from being torn down and rebuilt at the gate.
 * A portal whose container changes is deleted and remounted, never moved.
 */
function World({
  host,
  link,
  feedEpoch,
}: {
  host: HTMLElement | null;
  link: Link;
  feedEpoch: number;
}) {
  const arena = useSelect((s) => s.arena);
  const boss = useSelect((s) => s.boss);
  const players = useSelect((s) => s.players);
  const seat = useSelect((s) => s.match?.seat ?? -1);
  const tickMs = useSelect((s) => s.match?.tickMs ?? 100);

  useGameplay(host, link);

  if (!host || !arena || !boss || !players) return null;

  // `.hr-stage` sizes itself from its parent, and a portal's parent is the stage cell:
  // this grid box is what gives it one, so the fit hook has a rect to measure.
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
          behind it.

          `Passage`, not `Arena`: it *is* `Arena`, wrapped in the gate beat — it owns which
          room is on screen and the hold that keeps the local knight still under the veil,
          because during the 460 ms cover the room and the seat's own `zone` disagree on
          purpose. Mounting `Arena` directly still renders correctly; it just cuts. */}
      <Passage
        arena={arena}
        boss={boss}
        players={players}
        localSeat={seat}
        tickMs={tickMs}
        predictor={link?.predictor}
        feedEpoch={feedEpoch}
      />
    </div>,
    host,
  );
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
          // `shoot.rs` refuses outside the pit as hard as it refuses outside `FIGHTING`
          // (spec §6.1). Without this a seat that never crossed the gate sends a doomed
          // `Custom(9)` every 800 ms for the whole match, and — because sends are
          // fire-and-forget under `skipPreflight` — sees nothing at all for it.
          zone: slot?.zone ?? ZONE_LOBBY,
          // The class is the seat's own byte, off the roster and never off what the join
          // sent: `claim_seat` keeps a returning identity's class, so the two can differ.
          // It picks the damage and the cooldown, so the pump has to read it or the
          // archer's trigger gates on the knight's 800 ms.
          cls: slot === null ? 0 : classOf(slot),
        };
      },
      aimOrigin: () => {
        // Straight off `#camera`'s own screen matrix, which is the only thing that knows
        // the fitted `viewBox` (spec §1.8). The old `box.width / ARENA_UNITS` assumed the
        // whole 1024-unit world was on screen at scale 1; under the §1.2 fit that is wrong
        // on every stage aspect, and a wrong aim under `skipPreflight` produces no error
        // anywhere — it is indistinguishable from the shooting bug being fixed.
        //
        // Forward transform, not the inverse: this returns the knight's position in the
        // same client coordinates `attachControls` reads the pointer in.
        const camera = host.querySelector<SVGGElement>('#camera');
        const matrix = camera?.getScreenCTM();
        if (!matrix) return null;
        const point = new DOMPoint(predictor.self.x, predictor.self.y).matrixTransform(matrix);
        return { x: point.x, y: point.y };
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
      onTrigger: (dx, dy) => {
        // Every accepted trigger, live or practice, drawn at 0 ms from the exact pair that
        // went on the wire — the whole of "fix the person shooting mechanics I cannot see
        // anything". `shoot.rs` is hitscan and allocates no projectile, so there has never
        // been anything on screen to see; this is the tracer, and it is drawn from the
        // PREDICTED position because that is the knight the player is looking at.
        //
        // A practice shot reaches here and never reaches `onShoot`. That is the point: the
        // arrow answers "is the key bound", and only `damageDealt` answers "did it hurt".
        fireLocal({ seat: match.seat, x: predictor.self.x, y: predictor.self.y, dx, dy });
      },
      onShoot: (dx, dy) => {
        // Free aim: the raw `(i8, i8)` the pointer or the held keys produced, normalised
        // on chain. Not an octant — a top-centre boss on eight-way aim is measurably
        // unwinnable (33.6% of pit stands can hit anything at all, and the core never),
        // and the client is not trusted to resolve the hit either way.
        //
        // No `seq` on the wire for `shoot`, so it counts toward throughput and never
        // toward latency. Inventing a round trip for it would be a made-up number.
        recordSend();
        send(shoot({ ...common, boss: match.boss, session, seat: match.seat, dx, dy }));
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
      const state = store.getState();
      // `assert_playable` (handlers/player.rs:501) refuses `enter_gate` outside these
      // three, so from `PHASE_SETTLING` onward every send is a `WrongPhase` the client
      // cannot see — `skipPreflight` returns a signature and the `.catch` below only fires
      // on a transport failure. Without this a stranded seat pushes two doomed
      // transactions a second into the ER for as long as the tab is open. Not an ordering
      // test: `PHASE_MUSTERING` is 6, appended after `PHASE_ROLLED`.
      const phase = state.arena?.phase ?? PHASE_LOBBY;
      if (phase !== PHASE_LOBBY && phase !== PHASE_MUSTERING && phase !== PHASE_FIGHTING) return;
      const slot = mySeatSlot(state);
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

/**
 * Through the gate with the boss still asleep — arm the muster.
 *
 * This is where the "Wake it up" button went. The gate *is* the interaction: `enter_gate`
 * already records commitment permanently, so the first knight through it opens a
 * fixed-length window (`begin_muster` stamps `fight_at_tick = tick + MUSTER_TICKS`) and
 * the chain's own crank ends it. Nobody has to press anything, no host can disconnect
 * holding the raid hostage, and a raid can never fail to start.
 *
 * Nineteen of twenty clients lose the race and the route answers `already_started`, which
 * `startMatch` treats as the success it is.
 *
 * Both inputs are chain-authoritative *values*, not notifications, so the body runs once
 * per transition rather than once per `Players` write — which at twenty seats is ~10/s,
 * 68.4% of them carrying no change at all. `arena === null` reads as `undefined !== 0`,
 * so nothing fires before the first `Arena` snapshot lands.
 */
function useMuster(): void {
  const store = useStore();
  const throughGate = useSelect((s) => mySeatSlot(s)?.zone === ZONE_ARENA);
  const asleep = useSelect((s) => s.arena?.phase === PHASE_LOBBY);

  useEffect(() => {
    if (throughGate && asleep) void store.startMatch();
  }, [throughGate, asleep, store]);
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
function useMatchLink(onFeedDrop: () => void): Link {
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
            // The resync gate. `subscribeMatch` only calls this on a *change*, so this
            // fires once per departure from a healthy feed and every diff-triggered
            // cinematic re-baselines on the payload after it rather than replaying.
            if (health !== 'live') onFeedDrop();
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
    // `onFeedDrop` is a `useReducer` dispatch and therefore stable for the life of the
    // component; it is in the deps to satisfy the linter, never because it changes. A
    // callback that *did* change identity here would tear the subscription down and pay
    // the 1,681 ms outage this hook exists to avoid.
  }, [match, session, store, onFeedDrop]);

  return link;
}

// The gate self-check that used to live here is gone with the copy it guarded: `onGate`
// and the four `GATE_*` bounds are now emitted into `packages/client/src/map.ts` by
// `tools/gen_map.py`, out of the same `G` marks in `assets/map/arena.json` that produce
// `map::GATE_MIN_X`..`GATE_MAX_Y` on the chain. One fact, one place, nothing to diff.
