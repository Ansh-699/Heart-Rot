/**
 * The shell: four screens, one linear flow, no router — plus the two seams that make the
 * rest of `app/` reachable.
 *
 * Landing → character select → lobby → arena, and the way back — a settled match, or
 * Exit — is the loader and the next seat, never the select again: the store remembers
 * the marker and joins by itself (`screenOf`'s `'joining'`). The leaderboard is a detour
 * off the landing, a flag in the store rather than a step. A route table would buy
 * history, deep links and code splitting for a flow with no branches, no shareable URLs
 * and one bundle — so the "route" is `screenOf(state)`, which reads the seat's `zone`
 * straight off the chain.
 *
 * This file draws the chrome (the wordmark, the error bar, the void card) and owns two things
 * nothing else can own, because nothing else sees both the store and the match:
 *
 *   **In** — `useMatchLink` pins the ER with `assertErIdentity` (the Worker already proved
 *   the rest), opens `subscribeMatch` and
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
 * for both sides of the gate. The waiting room has no screen of its own: where to walk
 * is the three gate marks in `render/WaitingRoom.tsx`. The world is drawn by
 * `render/Passage.tsx`, which is `render/Arena.tsx` wrapped in the gate beat. All of it is
 * imported, never re-implemented: a second copy of the part list or the skin table drifts
 * from the chain
 * layout the moment either is touched.
 */

import { useEffect, useReducer, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  CLASS_COOLDOWN_TICKS,
  PHASE_LOBBY,
  PHASE_SETTLED,
  PHASE_SETTLING,
  TIER_NAMES,
  ZONE_ARENA,
  ZONE_LOBBY,
  autoAim,
  classOf,
  confirmSignature,
  assertErIdentity,
  createRpc,
  createSessionSigner,
  enterGate,
  gateAt,
  lockedTier,
  movePlayer,
  useDoor,
  refusalOf,
  sendInstructions,
  shoot,
  warmBlockhash,
  type HeartrotRpc,
  type SessionSigner,
  type ShotTier,
} from '@heartrot/client';

import { attachControls, octantAim } from './input/controls';
import { recordSend, recordSignature } from './net/metrics';
import DevPanel from './ui/DevPanel';
import { createPredictor, type Predictor } from './net/predict';
import { subscribeMatch, type MatchSubscription } from './net/subscribe';
import { chargeLocal } from './render/Knight';
import { Passage } from './render/Passage';
import { knockDir, rangeAim } from './render/SideRooms';
import { play } from './render/sfx';
import { beamDowngraded, fireLocal } from './render/Shot';
import { CharacterSelect } from './screens/CharacterSelect';
import { gateOpen } from './screens/Gate';
import { Leaderboard } from './screens/Leaderboard';
import { Onboarding, SeatLoader } from './screens/Onboarding';
import { mySeatSlot, screenOf, useSelect, useStore, type WorldUpdate } from './state/store';
import { Hud } from './ui/Hud';

/**
 * The least time between two knocks on the secret door. A held key pumps the refused-step
 * edge every slot; the chain rate-limits `use_door` on the move clock anyway, so this only
 * spares the wire, and a knock that lands closes the question by flipping the zone.
 */
const KNOCK_MS = 100;

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

/**
 * A transient line in the error bar, for a refusal nothing else will ever report.
 *
 * `setStatus(currentStatus, message)` writes the message WITHOUT moving the status, so the
 * connection dot stays honest and the world feed keeps clearing it. Never
 * `setStatus('error')`: that status is HELD (`store.ts`'s `HELD`) and the feed cannot clear
 * it, so one refused datagram out of the ten a second this app sends would brick the
 * session for the life of the tab.
 *
 * Module scope with two callers — `useGameplay` and `useGateEntry` — because both need the
 * same closure AND the same `clear` on unmount, and the second copy of eight lines is how
 * the two drift. Not a hook: it is called inside an effect, once per link.
 */
function transientNotice(store: ReturnType<typeof useStore>): {
  post: (message: string) => void;
  clear: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    post: (message: string): void => {
      store.setStatus(store.getState().status, message);
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (store.getState().error === message) store.setStatus(store.getState().status);
      }, NOTICE_MS);
    },
    clear: (): void => clearTimeout(timer),
  };
}

export default function App() {
  const screen = useSelect(screenOf);
  const phase = useSelect((s) => s.arena?.phase ?? PHASE_LOBBY);
  const status = useSelect((s) => s.status);
  const worldReady = useSelect((s) => s.arena !== null && s.players !== null);
  const store = useStore();

  /**
   * Tell the server the seat is free when the tab goes away.
   *
   * The Exit button covers a deliberate departure; this covers the other 90 % — closing
   * the tab, navigating away, backgrounding on mobile. Without it an abandoned raid runs
   * its full six minutes to enrage and then strands its arena in `SETTLING` forever,
   * because the only route allowed to settle one requires a live seated player and that
   * player is the one who just left. Twelve stranded arenas is a game nobody can join.
   *
   * `sendBeacon`, not `fetch`: the document is being torn down and a normal request is
   * cancelled with it. The browser hands the payload to the network stack and lets the
   * page die, which is exactly the contract needed here.
   *
   * `pagehide` rather than `beforeunload` — `beforeunload` is unreliable on mobile and
   * blocks the bfcache. `visibilitychange` catches the backgrounding case that never
   * fires `pagehide` at all. Both are idempotent: a second release for a seat already
   * gone answers `not_live` and does nothing.
   *
   * Best effort by construction — a crash or a lost network sends nothing, which is why
   * the Worker also reaps one stranded arena in the background of somebody else's join.
   */
  useEffect(() => {
    const release = (): void => {
      if (typeof navigator.sendBeacon !== 'function') return;
      void store.leaveBeaconBody().then((body) => {
        if (body === null) return;
        navigator.sendBeacon('/api/match/leave', new Blob([body], { type: 'application/json' }));
      });
    };
    // ONLY a real teardown, and `persisted` is the whole of the difference.
    //
    // This used to also listen on `visibilitychange`, which fires the moment a tab is
    // backgrounded — alt-tab, minimise, lock the screen, switch apps. It released the seat
    // of a player who had gone nowhere, and they came back to a tab still holding a match
    // whose seat no longer existed: no archer, and a HUD reading "down 0:00" off a zeroed
    // slot. Backgrounding is not leaving.
    //
    // `persisted === true` means the page is going into the bfcache and may be restored
    // intact, which is also not leaving. Only a discard releases.
    //
    // The cost of being wrong here is asymmetric and that is what settles it: releasing a
    // seat someone is still using is a player deleted mid-game, while failing to release
    // one is an arena the Worker's reaper collects on the next join.
    const onPageHide = (event: PageTransitionEvent): void => {
      if (!event.persisted) release();
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [store]);

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
        {/* The landing's one detour: a flag in the store, not a step, so `Back` returns to
            whatever screen the seat and the sign-in already say. */}
        {screen === 'leaderboard' && <Leaderboard />}
        {screen === 'select' && <CharacterSelect />}
        {/* Between seats — the first join, every rejoin after a verdict or Exit, the wait
            while the Worker warms the next arena: one card and nothing under it. The
            select is not shown again; the marker is on file (`screenOf`), and the card
            reads its own copy off `status`. */}
        {screen === 'joining' && <SeatLoader />}
      </main>
      <World host={hasStage ? stage : null} link={link} feedEpoch={feedEpoch} />
      {/* One HUD, both sides of the gate. Its clusters are `position: fixed`, so they are
          mounted once here rather than by each screen — which is also what finally puts a
          shot indicator in the waiting area, the one screen the dead spacebar lived on
          (spec §9.2). */}
      {/* Not before the world: the card would read LOBBY · tick 0 · connecting under the
          "Opening the arena" loader, which is the "old UI behind the loading screen". */}
      {hasStage && worldReady && <Hud />}
      {/* Not while settled: the verdict (`Hud.tsx`) is the results panel and the way out,
          on both sides of the gate, and this card would otherwise stack over it in the
          window where `Arena` says SETTLED and `Boss` has not landed yet. */}
      {hasStage && phase !== PHASE_SETTLED && <WorldPending />}
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
// There is no `ArenaScreen` any more, and no result card here either. The 320 px panel is
// deleted (spec §9.1), `Hud`'s fixed clusters replace it on both sides of the gate, and
// the verdict in `ui/Hud.tsx` is the results panel: it carries the way out (`Raid again`),
// so a second full-screen `.overlay` over it — which is what the old `Result` was — hid
// the button it was meant to be.
// ---------------------------------------------------------------------------

/**
 * The gap between "seated" and "drawable" — the void.
 *
 * `join()` resolves the moment `/api/session/init` hands back a seat, `screenOf` flips to
 * `'lobby'` on the same tick, and `Hud`'s dot reads the world feed as live. But `World`
 * below returns `null` until `arena` **and** `boss` **and** `players` have all arrived,
 * and those are three separate snapshots taken by `connectMatch` over a devnet round trip.
 * So the player was seated, told "live", and shown an empty black stage with no indication
 * that anything was happening. Every new player passed through it; the UX walk ranked it
 * first.
 *
 * The honest thing to show is the actual gate: which of the three accounts are here. That
 * is the whole progress indicator, and it cannot lie — it is read off the same three
 * fields `World` tests, so this card is on screen for exactly the frames the stage is
 * empty and not one more. No spinner, no percentage, no fake "almost there".
 *
 * `arrived` is a **bitmask**, not the three accounts: a primitive selector, so this
 * subscribes to the three notifications that flip a bit and to none of the ~714/s that do
 * not — the hot path stays as narrow as it was, which matters because it is the same path
 * a concurrent re-render fix is measuring.
 */
const PENDING_CSS = `
.pending-list { margin: 0; padding: 0; list-style: none; display: grid; gap: 7px; }
.pending-list li { display: flex; justify-content: space-between; gap: 16px; }
.pending-list .waiting { color: var(--dim); }
.pending-list .here { color: var(--flesh-lit); }
`;

function WorldPending() {
  const store = useStore();
  const seat = useSelect((s) => s.match?.seat ?? -1);
  const failed = useSelect((s) => s.status === 'error');
  // The error bar is a `.shell` grid row and this overlay is fixed over it at z-index 40,
  // so on the failure branch the card has to carry the reason itself or it is not readable
  // anywhere.
  const error = useSelect((s) => s.error);
  // The roster is "here" only with our seat on it: a room drawn around a roster that
  // lacks the player is the bare room the Sep 4 2026 bug showed, with no card, no
  // archer and nothing to say why. Under this card the seat guard is re-reading.
  const arrived = useSelect(
    (s) => (s.arena ? 1 : 0) | (s.boss ? 2 : 0) | (s.players && mySeatSlot(s) ? 4 : 0),
  );

  if (arrived === 7) return null;

  const rows: readonly (readonly [string, boolean])[] = [
    ['the room', (arrived & 1) !== 0],
    ['the boss', (arrived & 2) !== 0],
    ['the roster', (arrived & 4) !== 0],
  ];

  return (
    <div className="overlay">
      <style>{PENDING_CSS}</style>
      <div className="card" role="status" aria-live="polite">
        <p className="eyebrow">Seat {seat} is yours</p>
        <h2>{failed ? 'The arena did not open.' : 'Opening the arena'}</h2>
        <ul className="pending-list lede">
          {rows.map(([name, here]) => (
            <li key={name}>
              <span>{name}</span>
              <span className={here ? 'here' : 'waiting'}>{here ? 'here' : 'waiting'}</span>
            </li>
          ))}
        </ul>
        {failed ? (
          <>
            <p className="fine">{error}</p>
            {/* Otherwise this is a second dead end: `useMatchLink` treats a failed
                `connectMatch` as fatal for the match on purpose, and without a way out the
                player sits on this card for the life of the tab. `leaveMatch` drops the
                seat and takes a fresh one through the loader — the verdict's own exit. */}
            <button className="btn btn-primary" onClick={() => void store.leaveMatch()}>
              Take a new seat
            </button>
          </>
        ) : (
          <p className="fine">Waiting for the rollup · usually under a second.</p>
        )}
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
  const wantTier = useSelect((s) => s.wantTier);
  // Subscribed for its edge only: a predicted step re-renders the world (`pokePredicted`).
  useSelect((s) => s.predictedAt);
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
          for collisions — most of those carry no position change — so the
          local seat lerps P→P, holds, then jumps when a real move lands. Prediction is
          driven by input and cannot be re-anchored by a crank write. Remote seats keep
          interpolating; they have no input to predict from.

          `undefined` until `useMatchLink` resolves, which `Arena` reads as "interpolate
          every seat" — the prop is optional and deliberately not `| null`, so this is the
          one absent value it accepts. Same object `aim` reads below, so the auto-aim fires
          from the archer the player is actually looking at rather than from a position
          127 ms behind it.

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
        wantTier={wantTier}
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
    let lastKnock = -Infinity;
    let pendingHold: ShotTier | null = null;
    let holdFrame = 0;

    const { post: notice, clear: clearNotice } = transientNotice(store);

    // `sendInstructions` runs `skipPreflight`, so a refused instruction returns a
    // signature and then fails in silence. One confirm at a time samples that, ~2 status
    // polls a second, for the refusals that mean something is wrong and that nothing else
    // will ever report: a rotated session key, a phase this client missed. Two refusals
    // are read and dropped on purpose, because they are the mirrors' own traffic:
    // `RateLimited` (7) is two moves in one ER slot — `controls.ts` paces at 45 ms, UNDER
    // the 50 ms slot, deliberately, and prediction absorbs the refusal — and `PlayerDead`
    // (8) is a send that was in flight when the roster said dead, which the `alive` gate
    // stops from repeating. Both used to pop up mid-fight as a notice over a game that was
    // behaving exactly as designed.
    //
    // ponytail: one outstanding confirm per client. Confirm every send if a one-off
    // rejection ever needs to be attributed exactly.
    //
    // The one send that is never sampled out carries `downgrade`: a tiered shot, which the
    // chain refuses with `NotCharged` (20) BEFORE spending the cooldown when a step was
    // still in flight — the client cannot see that step land, so the refusal is the only
    // signal — and the same shot one tier down is what the chain would have taken. The
    // ladder is 2 -> 1 -> 0, one rung per refusal; the plain rung carries no callback.
    let confirming = false;

    const send = (
      instruction: Parameters<typeof sendInstructions>[2][number],
      downgrade?: () => void,
      txId?: number,
    ): void => {
      void sendInstructions(er, signer, [instruction])
        .then(async (signature) => {
          if (txId !== undefined) recordSignature(txId, signature);
          if (confirming && downgrade === undefined) return;
          confirming = true;
          try {
            await confirmSignature(er, signature, { timeoutMs: 2_000, pollMs: 400 });
          } finally {
            confirming = false;
          }
        })
        .catch((error: unknown) => {
          // `refusalOf`, never a hand-rolled parse and never `decodeTransactionError`
          // directly: the ER writes `InstructionError` members as JSON strings where base
          // devnet writes numbers and kit hands back bigints, and `confirmSignature`
          // throws with the decode already on `cause` — decoding that a second time
          // returns `code: undefined` and silently drops every refusal this confirm
          // exists to sample.
          const decoded = refusalOf(error);
          if (decoded.code === 20 && downgrade !== undefined) {
            downgrade();
            return;
          }
          // `BlockedByWall` (14) is expected traffic — one per tick from anyone holding a
          // direction into a wall — `RateLimited` (7) and `PlayerDead` (8) are the two
          // above, and a timeout is the ER being slow, not a refusal.
          // `WrongPhase` (6) is the end of a match: a send that left before the SETTLED
          // notification arrived, or a key still held on the results screen.
          // `NotOnGate` (15) is a knock that lost the slot race to a step, re-sent on the
          // next pump (`KNOCK_MS`).
          if (
            decoded.code === 6 ||
            decoded.code === 7 ||
            decoded.code === 8 ||
            decoded.code === 14 ||
            decoded.code === 15 ||
            decoded.code === undefined
          ) {
            return;
          }
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
      // downed player spending the rest of the raid sending shots the chain answers
      // with PlayerDead — a death is final, there is no respawn.
      clock: () => {
        const { arena, tickAt, match } = store.getState();
        const tickMs = match?.tickMs ?? 100;
        const slot = mySeatSlot(store.getState());
        // The tick as the chain most likely has it NOW, not as of the last notification:
        // the crank runs every `tickMs` whether or not the feed has said so, and the
        // notification that carried this tick took at least one tick to arrive. Pacing a
        // shot against the stale view spent that lag again on every arrow (measured: 766 ms
        // between sends against a 400 ms gate). In the steady state the credit is one tick
        // and the cap never binds: with `SHOT_MARGIN_TICKS` the view may run a tick ahead
        // of the chain and a shot still lands past the cooldown. The cap is only for a feed
        // that has stopped — see `AHEAD_CAP_TICKS`.
        const ahead = arena
          ? Math.min(
              AHEAD_CAP_TICKS,
              Math.floor((performance.now() - tickAt + NOTIFY_LAG_MS) / tickMs),
            )
          : 0;
        return {
          phase: arena?.phase ?? PHASE_LOBBY,
          tick: (arena?.tick ?? 0) + ahead,
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
          // The chain's own stamp of the last accepted shot, which can be later than the
          // tick this client saw at the send: the pump paces against the later of the two.
          lastShotTick: slot?.lastShotTick ?? 0,
        };
      },
      aim: () => {
        // Auto-aim, from the PREDICTED position — the archer the player is looking at, not
        // the one Singapore has — in arena units, the space `predictor.self` and the boss
        // already share. No screen matrix is involved anywhere on the shot path any more:
        // the old pointer aim went through `#camera`'s CTM, and a wrong aim under
        // `skipPreflight` produces no error anywhere. Nothing in reach — a stripped shell
        // with the vent sealed, or the waiting area — aims along the body's own facing,
        // exactly as accurate as the eight-way client was.
        const { boss } = store.getState();
        const picked = boss === null ? null : autoAim(predictor.self.x, predictor.self.y, boss);
        // In the range the straw is the target: the nearest man, picked the way the creature is.
        const zone = mySeatSlot(store.getState())?.zone;
        const straw = picked ?? (zone === undefined ? null : rangeAim(zone, predictor.self.x, predictor.self.y));
        return straw ?? octantAim(predictor.self.facing);
      },
      onMove: (dir) => {
        // `push` returns `null` when the chain would reject the move anyway — a wall, or a
        // dead player — and sending it then would burn a slot in the one-move-per-tick
        // budget on a transaction that cannot land. It also applies the same `MOVE_STEP`
        // the handler indexes with `dir`, so the predicted step and the chain's are one
        // table and cannot disagree.
        const seq = predictor.push(dir);
        if (seq === null) {
          // Refused before the wire: a wall. Pushed from the secret door's threshold on
          // either side, that wall IS the door, and the knock is a real instruction:
          // `use_door` moves the seat through it (`SecretRoom.tsx`). The zone is the
          // chain's, the position the prediction's — at a threshold the two agree.
          const zone = mySeatSlot(store.getState())?.zone;
          const now = performance.now();
          if (zone !== undefined && dir === knockDir(zone, predictor.self.x, predictor.self.y) && now - lastKnock >= KNOCK_MS) {
            lastKnock = now;
            send(useDoor({ ...common, session, seat: match.seat }), undefined, recordSend(undefined, 'gate'));
            play('door');
          }
          return;
        }
        // Recorded before the send, so a transaction that never resolves still counts as
        // in flight and ages into the unacked bucket rather than vanishing.
        const txId = recordSend(seq, 'move');
        send(movePlayer({ ...common, session, seat: match.seat, dir, seq }), undefined, txId);
        // After the send, never before it: the world re-renders so the knight's facing and
        // gait fold on the next frame rather than on the chain's echo of this step.
        store.pokePredicted();
      },
      onTrigger: (dx, dy, tier) => {
        // Every accepted trigger, live or practice, drawn at 0 ms from the exact pair that
        // went on the wire — the whole of "fix the person shooting mechanics I cannot see
        // anything". `shoot.rs` is hitscan and allocates no projectile, so there has never
        // been anything on screen to see; this is the tracer, and it is drawn from the
        // PREDICTED position because that is the knight the player is looking at.
        //
        // A practice shot reaches here and never reaches `onShoot`. That is the point: the
        // arrow answers "is the key bound", and only `damageDealt` answers "did it hurt".
        fireLocal({ seat: match.seat, x: predictor.self.x, y: predictor.self.y, dx, dy, tier });
      },
      onShoot: (dx, dy, tier) => {
        // Free aim: the raw `(i8, i8)` the auto-aim picked, normalised on chain. Not an
        // octant — a top-centre boss on eight-way aim is measurably unwinnable (33.6% of
        // pit stands can hit anything at all, and the core never), and the client is not
        // trusted to resolve the hit either way.
        //
        // No `seq` on the wire for `shoot`, so it counts toward throughput and never
        // toward latency. Inventing a round trip for it would be a made-up number.
        const txId = recordSend(undefined, 'shoot');
        const ix = (t: ShotTier) => shoot({ ...common, boss: match.boss, session, seat: match.seat, dx, dy, tier: t });
        // A tiered send that loses the race with a step in flight is refused for free; the
        // answer is the same shot one tier down, once per rung — see `send`. The beam
        // already drawn estimated a super's damage per part; the number the chain reports
        // for the lesser shot is the right one, so `Shot` is told to draw it after all.
        const fire = (t: ShotTier): void =>
          send(ix(t), t === 0 ? undefined : () => { beamDowngraded(); fire((t - 1) as ShotTier); }, txId);
        fire(tier);
      },
      onCharge: (hold) => {
        // The hold's edge, for the local archer only: the draw pose, the arcs and the ready
        // cues are `Knight`'s, played there as each tier lands; the draw itself is cued
        // here, on the stand's first pump, so the two cannot double up.
        //
        // The pose is committed on the next frame, not under the keydown: `chargeLocal`
        // is a React state write, and React flushes a discrete-event update synchronously
        // — ahead of the shot's signature and its POST. One frame later is invisible; the
        // send is the thing the key is for. Last value wins, in order, so a release that
        // lands in the same task as a draw cannot leave the archer drawn.
        pendingHold = hold;
        if (holdFrame === 0) {
          holdFrame = requestAnimationFrame(() => {
            holdFrame = 0;
            chargeLocal(pendingHold);
          });
        }
        if (hold === 0) play('chargeStart');
      },
    });

    return () => {
      clearNotice();
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
    const { post: notice, clear: clearNotice } = transientNotice(store);
    let inFlight = false;

    const timer = setInterval(() => {
      if (inFlight) return;
      const state = store.getState();
      // `assert_playable` (handlers/player.rs:502) refuses `enter_gate` outside three
      // phases, so from `PHASE_SETTLING` onward every send is a `WrongPhase` nobody can
      // act on. Without this a stranded seat pushes two doomed transactions a second into
      // the ER for as long as the tab is open.
      //
      // `gateOpen` is `assert_playable` mirrored, not the three phases spelled out again
      // here: a phase missing from it stops sends the chain would take, a phase wrongly in
      // it sends into `WrongPhase`, and `Gate.tsx`'s dev self-check pins the mirror.
      if (!gateOpen(state.arena?.phase ?? PHASE_LOBBY)) return;
      const slot = mySeatSlot(state);
      if (!slot || slot.zone !== ZONE_LOBBY) return;
      // Any of the three gates; `gateAt` is the predicate `enter_gate` runs.
      const here = gateAt(slot.x, slot.y);
      if (here === null) return;
      // The raid fights ONE boss, tuned by the gate its first raider chose. The chain
      // refuses every other doorway with `WrongGate` (21), and unlike `NotOnGate` no
      // amount of standing still heals it — so this loop does not send it. The notice is
      // the whole answer, re-posted each period the player stands there and gone
      // `NOTICE_MS` after they walk off; `lockedTier` is `player::locked_tier`, mirrored.
      const locked = state.arena === null ? null : lockedTier(state.arena);
      if (locked !== null && here !== locked) {
        notice(`This raid is ${TIER_NAMES[locked]}. Walk to the ${TIER_NAMES[locked]} gate.`);
        return;
      }
      inFlight = true;
      const gateTx = recordSend(undefined, 'gate');
      void sendInstructions(er, signer, [
        enterGate({
          programId: match.programId,
          arena: match.arena,
          players: match.players,
          session: signer.address,
          seat: match.seat,
        }),
      ])
        // The gameplay path samples its confirms because `move` and `shoot` run ten times
        // a second. This runs twice a second, at most one outstanding, and its refusals are
        // the UNRECOVERABLE ones — `WrongSessionKey` (a second tab rotated the seat's key),
        // `WrongPhase` racing the crank. Sending it with `skipPreflight` and no confirm at
        // all made every one of them silent, on the one screen whose copy tells the player
        // to stand still and stop generating the traffic that would reveal them.
        .then((signature) => {
          recordSignature(gateTx, signature);
          return confirmSignature(er, signature, { timeoutMs: 1_500, pollMs: 300 });
        })
        .catch((error: unknown) => {
          // Same reader as the gameplay path, and for the same reason: `confirmSignature`
          // throws with the decode on `cause` and `sendInstructions` throws undecoded, so
          // only `refusalOf` gets `code` out of both.
          const decoded = refusalOf(error);
          // The two that heal themselves on the next 500 ms period, and are the reason
          // `error.rs:231` splits them at all: `NotOnGate` (15) is "the chain has not seen
          // your last step yet", `WrongZone` (9) is "you are already through". `undefined`
          // is a confirm timeout or a dropped send — the ER being slow, not a refusal, and
          // ignored exactly as the gameplay path ignores it.
          if (decoded.code === 15 || decoded.code === 9 || decoded.code === undefined) return;
          notice(`The gate refused you: ${decoded.name ?? `Custom(${decoded.code})`} — ${decoded.message}`);
        })
        // Held through the confirm on purpose: one `enter_gate` outstanding at a time, and
        // 1_500/300 caps the worst-case gap between retries at ~2 s.
        .finally(() => {
          inFlight = false;
        });
    }, GATE_RETRY_MS);

    return () => {
      clearInterval(timer);
      clearNotice();
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
/** The least a notification takes to come back: one tick, the credit the pump's clock gives itself. */
const NOTIFY_LAG_MS = 100;

/**
 * How far the pump's clock may credit itself past the last notified tick while the feed is
 * silent. Derived, never typed: the longest class cooldown (knight, 7 ticks) plus the gate's
 * own `SHOT_MARGIN_TICKS` plus the one tick its `>` demands, so one whole cooldown still
 * clears during a stall.
 *
 * This was 5, which is UNDER the knight's 7+1, so once the feed stalled — measured at 0.3
 * to 2.5 s per connection, while HTTP to the same ER kept answering in ~90 ms — the credit
 * froze below the gate and every tap for the rest of the stall was refused with nothing on
 * screen. A credit that runs too far ahead costs one refused shot and one resend; a frozen
 * one costs every shot in the stall.
 */
const AHEAD_CAP_TICKS = Math.max(...CLASS_COOLDOWN_TICKS) + 2;

/** How long the roster may lack our own seat before the accounts are re-read, and after how many re-reads the seat is re-claimed instead. */
const SEAT_SEEN_MS = 3_000;
const SEAT_SEEN_TRIES = 4;

/**
 * How often to poke the ER with one `getLatestBlockhash` while nobody is pressing anything.
 *
 * Two measured stalls, one request: after 30 s still the cached hash is stale and the first
 * input waits 81-142 ms on a serial fetch, and past the ER nginx's 75.3 s idle close the
 * browser's only h2 connection is gone, so that first keypress pays connect+TLS+hash —
 * 270-320 ms, which is the "he pressed a key and the character moved much later" the owner
 * saw while the two of them stood talking. 20 s keeps the hash inside its refresh window and
 * puts three keepalives inside the 75.3 s close, for 96 bytes a poke.
 */
const WARM_MS = 20_000;

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
    let seatCheck = 0;
    let warmCheck = 0;
    let onVisible: (() => void) | null = null;
    // One React render per animation frame, not one per WebSocket message. Every payload
    // used to be its own SyncLane render of World -> Passage -> Arena; at twenty seats that
    // is hundreds a second against sixty frames. The merge keeps the newest of each
    // account; nothing downstream diffs events, only values, so a merged pair reads as one.
    // Prediction still reconciles per payload, below. A hidden tab gets a timer instead.
    let pending: WorldUpdate | null = null;
    let flush: { id: number; timer: boolean } | null = null;
    const runFlush = (): void => {
      flush = null;
      const update = pending;
      pending = null;
      if (update !== null && !cancelled) store.setWorld(update);
    };
    const queue = (update: Omit<WorldUpdate, 'from'>): void => {
      pending = { ...(pending ?? { from: match.arenaPda }), ...update };
      if (flush !== null) return;
      flush = document.hidden
        ? { id: window.setTimeout(runFlush, 0), timer: true }
        : { id: requestAnimationFrame(runFlush), timer: false };
    };
    let seatSeen = false;
    let seatRetry = 0;
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
        // The Worker already resolved this ER by the arena's validator identity, read and
        // wrote the three accounts on it and confirmed the claim before it answered; the
        // client used to re-prove all of that here — four serial round trips, two of them on
        // a router connection opened only for them — before the first frame. One check
        // stays, and runs beside the feed's opening rather than ahead of it: the endpoint
        // answers as the validator the arena names, the one thing never to be guessed.
        const er = createRpc(match.erEndpoint);
        const pinned = assertErIdentity(er, addr(match.validatorIdentity));

        // Keep the blockhash cache and the h2 socket warm for the whole life of the link —
        // see `WARM_MS`. Single-flight and it never throws, so it can be fired and dropped.
        void warmBlockhash(er);
        warmCheck = window.setInterval(() => void warmBlockhash(er), WARM_MS);
        // And on the way back from a hidden tab, where the interval was throttled or frozen:
        // the first key after a return otherwise paid the stale hash and the closed socket.
        onVisible = () => {
          if (document.visibilityState === 'visible') void warmBlockhash(er);
        };
        document.addEventListener('visibilitychange', onVisible);

        // THE SEAT MUST APPEAR, AND STAY. The Worker confirmed the claim before it
        // answered, but the roster the feed shows can still lack our seat: a snapshot
        // from a node that has not seen the claim, or a frame the feed should not have
        // applied. In a LOBBY nothing rewrites `Players` until someone moves, and with
        // the seat missing the predictor refuses to move — so the room stays bare for
        // good. Every `SEAT_SEEN_MS` the latest roster lacks our seat, read the accounts
        // again; on the last try re-claim through the Worker, which for a returning
        // identity re-lands the same seat in place — a `Players` write, the one thing a
        // lobby roster otherwise never gets. Each try logs, so it is attributable.
        seatCheck = window.setInterval(() => {
          if (cancelled) {
            window.clearInterval(seatCheck);
            return;
          }
          if (seatSeen) {
            seatRetry = 0;
            return;
          }
          seatRetry += 1;
          const last = seatRetry >= SEAT_SEEN_TRIES;
          console.warn(
            `feed: seat ${match.seat} not on the roster after ${seatRetry * SEAT_SEEN_MS} ms; ${last ? 're-claiming' : 're-reading'}`,
          );
          if (last) {
            window.clearInterval(seatCheck);
            void store.join();
            return;
          }
          subscription?.resnapshot();
        }, SEAT_SEEN_MS);
        subscription = subscribeMatch({
          rpc: er,
          ...accounts,
          owner: addr(match.programId),
          onArena: (arena, tickAt) => {
            if (cancelled) return;
            queue({ arena, tickAt });
          },
          onBoss: (boss) => {
            if (cancelled) return;
            queue({ boss });
          },
          onPlayers: (players) => {
            if (cancelled) return;
            queue({ players });
            const slot = players.slots[match.seat];
            seatSeen = slot?.occupied === true;
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
            //
            // Only from a seat that is ours, though: an empty slot is hp 0, and a
            // predictor fed hp 0 refuses every input, which is how a bare room became a
            // room the player could not even walk in.
            if (slot?.occupied) predictor.reconcile(slot);
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

        // The pin resolves in the same round trip the feed spends opening. A mismatch is
        // fatal for the match, as it always was; the feed it would have fed is closed.
        await pinned;
        if (cancelled) return;

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
        // The keepalive goes with the match it was keeping alive. The cleanup below clears
        // it too, but that only runs when the effect re-runs or unmounts, and a match that
        // has already failed has nothing left to keep warm in the meantime.
        window.clearInterval(warmCheck);
        if (onVisible !== null) document.removeEventListener('visibilitychange', onVisible);
        subscription?.close();
        subscription = null;
        if (cancelled) return;
        // Fatal for this match: no ER means no world and no gameplay, and a silent retry
        // loop would look exactly like a frozen game.
        store.setStatus('error', error instanceof Error ? error.message : String(error));
      }
    })();

    return () => {
      cancelled = true;
      window.clearInterval(seatCheck);
      window.clearInterval(warmCheck);
      if (onVisible !== null) document.removeEventListener('visibilitychange', onVisible);
      if (flush !== null) (flush.timer ? window.clearTimeout : cancelAnimationFrame)(flush.id);
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

// The gate self-check that used to live here is gone with the copy it guarded: `gateAt`
// and the three `GATES` blocks are emitted into `packages/client/src/map.ts` by
// `tools/gen_map.py`, out of the same `G` blocks in `assets/map/arena.json` that produce
// `map::GATES` on the chain. One fact, one place, nothing to diff.
