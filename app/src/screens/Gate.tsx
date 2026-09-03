/**
 * The gate's phase rule — the one piece of the pre-fight that belongs to **neither**
 * screen.
 *
 * This is not a screen and must not become one. `screenOf` has six values and the gate is
 * not one of them: the gate is a tile you walk onto in the lobby, and the instant your
 * `enter_gate` lands your own seat's `zone` flips and `screenOf` moves you to the arena. A
 * seventh screen wedged in between would have to be entered and left on a chain fact that
 * already moves you, i.e. it would be a second router disagreeing with the first.
 *
 * Everything else that used to live here is in the world now. The approach prompt and
 * the muster card were text over a painting the room exists to show; the three gate marks
 * (`WaitingRoom.tsx`) say where to walk, the gate clock (`Arena.tsx`) says when the boss
 * wakes, and `App.tsx`'s `useGateEntry` — the authoritative 500 ms poll — is the one thing
 * that sends `enter_gate`, and the one voice when it will not: a raid locked to another
 * tier's gate is a notice in the error bar, not a prompt of its own.
 */

import { PHASE_FIGHTING, PHASE_LOBBY, PHASE_MUSTERING, PHASE_ROLLED, PHASE_ROLLING, PHASE_SETTLED, PHASE_SETTLING } from '@heartrot/client';

/**
 * Will the chain take an `enter_gate` at all in this phase?
 *
 * `assert_playable` (`handlers/player.rs`), mirrored. Exported because `App.tsx`'s retry
 * loop tests it to decide whether to send at all — from `PHASE_SETTLING` on every send is a
 * `WrongPhase` nobody can act on, and without this a stranded seat pushes two doomed
 * transactions a second into the ER for as long as the tab is open.
 */
export function gateOpen(phase: number): boolean {
  return phase === PHASE_LOBBY || phase === PHASE_MUSTERING || phase === PHASE_FIGHTING;
}

// ---------------------------------------------------------------------------
// Self-check
//
// The one silent-failure predicate left here: a phase missing from `gateOpen` stops the
// loop sending for a player the chain would still admit, and a phase wrongly included has
// it sending into refusals. Both are invisible without this. Dev-only.
// ---------------------------------------------------------------------------

if (import.meta.env.DEV) {
  const fail = (message: string): never => {
    throw new Error(`Gate self-check: ${message}`);
  };
  for (const open of [PHASE_LOBBY, PHASE_MUSTERING, PHASE_FIGHTING]) {
    if (!gateOpen(open)) fail(`phase ${open} takes enter_gate and gateOpen says it does not`);
  }
  for (const shut of [PHASE_SETTLING, PHASE_SETTLED, PHASE_ROLLING, PHASE_ROLLED]) {
    if (gateOpen(shut)) fail(`phase ${shut} refuses enter_gate and gateOpen says it does not`);
  }
}
