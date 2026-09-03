/**
 * The waiting area's one line of copy — the whole of what is left of the lobby screen.
 *
 * There is no queue service and there is no room for one. "Walk onto the gate" is the whole
 * feature, and every byte of state it needs is already on chain: standing on the gate tile
 * sends `enter_gate`, which flips that seat's `zone` to `ZONE_ARENA`. There is no "enter the
 * gate" button here, and — since `docs/architecture/08-gate.md` §6 — no "wake it up" button
 * on the far side either. The gate is a tile you walk onto, and a button would be a second
 * way to do the same thing that skips the part where twenty knights visibly crowd onto one
 * arch. That crowd *is* the matchmaking UI.
 *
 * **The 320 px panel this screen used to be is gone** (`17-fullscreen-spec.md` §9.1: it cost
 * the worst-case scale 0.6875 px/unit and a 22.7 px knight, and the user asked for full
 * screen twice). Everything it carried now lives somewhere that already owned the fact:
 *
 *   roster and seat counts → `Hud`'s top-left cluster, twenty dots
 *   the muster countdown   → `Hud`'s top-centre cluster, which renders `Gate.tsx`'s
 *                            `<Muster />` on both sides of the gate
 *   health, class, cadence → `Hud`'s `SelfPanel`, now mounted in the waiting area too —
 *                            which is the whole of the "the space bar doesn't work"
 *                            visibility fix, since this was the one screen with no shot
 *                            indicator on it at all
 *
 * What is genuinely this screen's is the instruction: where to walk, and what happens when
 * you get there. Spec §9.2 anchors it bottom-centre, over the room rather than beside it.
 *
 * **The gate check is not this screen's, and must never become an input callback's.**
 * `App.tsx`'s `useGateEntry` polls the authoritative seat — whatever the last `Players`
 * notification wrote — every 500 ms and re-sends until `zone` actually flips. The version
 * that fired inside `onMove` stranded players permanently: under `skipPreflight` the chain
 * still had them off the tile, the rejection was invisible, and a player who stopped
 * pressing keys produced no further `onMove` and so no retry. Hence the copy telling people
 * they can stand still — with the poll, that is true.
 *
 * This screen ends by itself: `screenOf` derives the arena screen from your own seat's
 * `zone`, so the moment your gate transaction lands the next notification moves you —
 * mid-countdown, which is why the countdown lives in `screens/Gate.tsx` and is rendered by
 * `Hud` rather than by this file.
 */


/**
 * Bottom centre, the one anchor `Hud` does not already use.
 *
 * Same `.hud` chrome as every other cluster and deliberately not a second style: it is
 * `Hud`'s block that defines the translucency, the border and the `pointer-events: none`
 * that keeps this off the aim. Only the anchor is new.
 *
 * ponytail: two `<style>` blocks for one design system. Fold this line into `HUD_CSS` if a
 * second cluster ever wants the bottom-centre anchor.
 */
const LOBBY_CSS = `
.hud-bc {
  bottom: 8px;
  left: 50%;
  transform: translateX(-50%);
  /* Bounded by the cluster BESIDE it, not by a fraction of the window. .hud-bl is
     min-width 232px at left 8px bottom 8px, so 72vw ran into it by 8px at 1024 wide —
     which is the first row of the spec's own scale table — and by 70px at 900. The
     subtrahend is that cluster twice over plus its gutters: 2 x (232 + 8 + 8) = 496.
     The max() is only a floor: under ~656px there is no arrangement of a 232px cluster
     and a centred one that does not touch, and a calc that resolves negative would
     collapse this box to nothing. Both clusters are pointer-events: none, so what is at
     stake is legibility and never input. */
  width: min(560px, max(160px, calc(100vw - 496px)));
  text-align: center;
}
.hud-bc .vent { border: 0; background: none; padding: 0; }
/* GatePrompt renders nothing once your seat is through the gate. Without this the
   cluster's border, padding and translucent panel stay on screen as an empty box. */
.hud-bc:empty { display: none; }
`;

export function Lobby() {
  return (
    <>
      {/* No `#stage` here. `App` declares the one stage node and both screens share it,
          because a portal whose container changes identity is deleted and rebuilt, not
          moved — and this screen ends by handing the arena straight to the next one. */}
      <style>{LOBBY_CSS}</style>
    </>
  );
}
