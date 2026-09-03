/**
 * The landing — the first screen, and there is no login wall on it.
 *
 * One clip, one sentence, two buttons and a link. `Play now` is the primary action and it
 * needs nothing from the visitor: the session key is generated in this tab and is the
 * whole identity (`store.playAsGuest`), and the routes accept its signature in place of a
 * Privy token. A wallet used to be the price of seeing the game at all, and a visitor
 * without Phantom installed was told so in ninety words on a card; the clip is now what
 * says what the game is, and the sentence says what makes it unusual.
 *
 * `Sign in` keeps the Privy path exactly as it was — a Solana wallet proves who you are
 * once, and the DID is the durable identity across browsers and cleared storage. A guest's
 * identity is the key's, so it lasts as long as IndexedDB keeps the key and no longer,
 * which is why the verdict offers a guest a sign-in in one muted line (`ui/Hud.tsx`) —
 * an offer, not a gate: the one-raid block was the popup the player asked to lose.
 *
 * **Privy is identity only, and that is a constraint rather than a preference.** It hands
 * back a DID and a JWT; it never signs a transaction. Its headless path runs
 * `initializeWalletProxy(15_000)` and a wallet recovery before the *first* signature of a
 * session — a 15-second ceiling, and under user-controlled recovery it throws with no modal
 * fallback — and signatures meter at $0.01 each above 50K/month, which twenty players at
 * gameplay rates burn through in under an hour. On a 400 ms tick none of that is
 * survivable. Every gameplay signature comes from the non-extractable WebCrypto key
 * `store.signIn()` resolves alongside the token, and the wallet is never asked again.
 *
 * **The funding card is deleted and must not come back.** ER transaction fees are zero and
 * the ER's vendored SVM has no `validate_transaction_fee_payer` at all, so the session
 * keypair needs no SOL on either layer.
 *
 * This is the only file in `app/src` besides `main.tsx` that imports the Privy SDK, and it
 * imports exactly one hook: the connect modal is the one thing the store's `AuthSource`
 * seam — "give me a token" — cannot express.
 */

import { useEffect } from 'react';
import { usePrivy } from '@privy-io/react-auth';

import { useSelect, useStore } from '../state/store';

/**
 * The card is 560 px everywhere else; the clip earns a wider one so that it reads as
 * gameplay and not as a thumbnail. The box is fixed at 16:9 and painted before the first
 * frame arrives, so nothing under it moves when the poster lands and again when the
 * video does. The link is a button in the accessibility tree and a link to the eye: it
 * changes the screen and nothing else, and a bordered third button would give three
 * actions equal weight when only one is the offer.
 */

/**
 * The text link, for both cards in this file: a button in the accessibility tree and a
 * link to the eye. Declared once and inlined into each card's block, because only one
 * of the two is ever mounted and a rule the other card carried would not be there.
 */
const LINK_CSS = `
.card .link { padding: 0; border: 0; background: none; cursor: pointer; font: 10px var(--pixel); letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
.card .link:hover, .card .link:focus-visible { color: var(--ink); outline: none; }
`;

const LANDING_CSS = `${LINK_CSS}
.card.landing { max-width: 720px; }
.landing video { display: block; width: 100%; aspect-ratio: 16 / 9; background: #000; border: 1px solid var(--line); }
.landing .row { align-items: center; }
.landing .link { margin-left: auto; }
`;

export function Onboarding() {
  const store = useStore();
  const busy = useSelect((s) => s.status === 'joining');
  const { ready, authenticated, login } = usePrivy();

  /**
   * Two steps, because the proof and the key have different owners: Privy's modal proves
   * who you are, then `store.signIn()` turns that into the token *and* the session keypair
   * the rest of the game signs with. The effect is what joins them — `login()` returns
   * void and only reports back by flipping `authenticated`, so nothing else would carry
   * the flow forward. It is also what picks up a returning tab, where Privy restores the
   * session and `authenticated` is already true by the time this card first renders.
   *
   * It cannot loop: `signIn` flips the store's own `authenticated`, which moves `screenOf`
   * to `'select'` and unmounts this card. On failure the store holds `status: 'error'`
   * (rendered by the shell's error bar) and the button below re-arms as the retry.
   */
  useEffect(() => {
    if (authenticated) void store.signIn();
  }, [authenticated, store]);

  /**
   * Already authenticated means the modal has nothing left to ask — this press is a retry
   * after a failed token fetch or a failed key unwrap — so it goes straight at `signIn`.
   */
  const connect = () => {
    if (authenticated) void store.signIn();
    else login();
  };

  return (
    <section className="card landing">
      <style>{LANDING_CSS}</style>
      {/* Six seconds of the fury phase with a charged shot, recorded off the harness.
          React sets `muted` as a property and not as an attribute, and Chrome's autoplay
          policy reads the attribute at parse time — the ref is what makes the loop actually
          start. Decorative: the sentence below is the accessible content. */}
      <video
        ref={(video) => {
          if (video) video.muted = true;
        }}
        src="/clip.webm"
        poster="/clip.jpg"
        autoPlay
        muted
        loop
        playsInline
        aria-hidden="true"
      />
      <p className="lede">
        A co-op boss raid where every move and every arrow is a Solana transaction.
      </p>
      <div className="row">
        <button className="btn btn-primary" onClick={() => void store.playAsGuest()} disabled={busy}>
          {busy ? 'Taking a seat…' : 'Play now'}
        </button>
        <button className="btn" onClick={connect} disabled={!ready || busy}>
          Sign in
        </button>
        <button className="link" onClick={() => store.showLeaderboard()}>
          Leaderboard
        </button>
      </div>
      <p className="fine">
        Play now takes a seat as a guest. Signing in with a Solana wallet keeps your name on
        the leaderboard. Devnet only; nothing to buy and nothing to approve.
      </p>
    </section>
  );
}

/**
 * Card 2 — between seats.
 *
 * The shell renders it for `'joining'`: a signed-in player with no seat and a marker on
 * file (`store.ts::screenOf`). That is the first join after the select, every rejoin after
 * a verdict or Exit, and the wait while the Worker builds the next arena — one card and
 * nothing under it, because the player asked for the loader and not the select, and a
 * second "Take a seat" under a "preparing" line is a second retry loop.
 *
 * The label is the store's own `status`, so the card cannot say one thing while the store
 * does another. `warming` is `join` retrying `no_open_arena` / `try_again` every 3 s
 * (`store.ts::WARMING`) while the Worker spends 30–60 s of devnet round trips on the next
 * arena; a join that landed in that window used to print "The lobby is between arenas …
 * try again" and hand the player the retry to do by hand. Anything else is the measured
 * ~2.8 s of `POST /api/session/init`, named because an unlabelled wait that long reads as
 * broken rather than as slow. The dot is the only motion, and it stops under reduced
 * motion because the ellipsis already says the same thing.
 *
 * `error` is the refusal a retry cannot fix by itself (`arena_full`, a dry treasury, an
 * expired sign-in); the sentence is in the shell's error bar, so the card carries only the
 * two ways on — the same seat again, or the select, which is also where a different
 * wallet is chosen.
 */
const WARMING_CSS = `${LINK_CSS}
.warming { min-width: 300px; gap: 8px; }
.warming .label { margin: 0; font: 10px var(--pixel); letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
.warming .dot { display: inline-block; width: 6px; height: 6px; margin-left: 8px; vertical-align: 1px; background: var(--torch); animation: warming-blink 1.2s steps(1) infinite; }
.warming .row { align-items: center; margin-top: 4px; }
@keyframes warming-blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .warming .dot { animation: none; } }
`;

export function SeatLoader() {
  const store = useStore();
  const status = useSelect((s) => s.status);

  if (status === 'error') {
    return (
      <section className="card warming" role="status">
        <style>{WARMING_CSS}</style>
        <p className="label">No seat yet</p>
        <div className="row">
          <button className="btn btn-primary" onClick={() => void store.join()}>
            Try again
          </button>
          <button className="link" onClick={() => void store.changeMarker()}>
            Change marker
          </button>
        </div>
      </section>
    );
  }

  const warming = status === 'warming';
  return (
    <section className="card warming" role="status" aria-live="polite" aria-busy="true">
      <style>{WARMING_CSS}</style>
      <p className="label">
        {warming ? 'Arena warming…' : 'Taking a seat…'}
        <span className="dot" aria-hidden="true" />
      </p>
      <p className="fine">
        {warming
          ? 'Preparing your arena…'
          : 'Finding the open arena and claiming your seat. Around three seconds.'}
      </p>
    </section>
  );
}
