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

import { useEffect, useRef, useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';

// The painted arena, the same file `render/rooms.gen.ts` draws the room from: the first
// screen is the dungeon, not a void.
import arenaPng from '../render/rooms/arena.png?no-inline';
import { useLeaderboard } from '../net/leaderboard';
import { useSelect, useStore } from '../state/store';
import { SKIN_COLORS, SKIN_NAMES } from './CharacterSelect';

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
/* The room behind the card, fixed and full-bleed, at ~30 % through a wash of the page
   ground that fades to solid at both edges. A pseudo-element: nothing in the tree, nothing
   to hit-test, nothing to read. The shell isolates so the layer sits under its own in-flow
   children (header, wordmark, card) and above nothing else. */
.shell:has(> .main > .landing) { isolation: isolate; }
.shell:has(> .main > .landing)::before { content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none;
  background: linear-gradient(var(--ground) 0%, rgb(8 13 20 / 0.7) 18%, rgb(8 13 20 / 0.7) 82%, var(--ground) 100%), url(${arenaPng}) center / cover no-repeat; }
.shell:has(> .main > .landing) > .header { background: none; border-bottom-color: transparent; }
/* Two rows now, the wordmark and the card, packed to the middle instead of each centred
   in half the window; \`safe\` so a short window scrolls from the top instead of clipping. */
.main:has(> .landing) { align-content: safe center; row-gap: 22px; }
.landing-mark { margin: 0; font: 56px/1 var(--pixel); letter-spacing: 0.02em; color: var(--flesh); text-align: center; }
.card.landing { max-width: 720px; }
.landing video { display: block; width: 100%; aspect-ratio: 16 / 9; background: #000; border: 1px solid var(--line); }
.landing .row { align-items: center; }
.landing .link { margin-left: auto; }
.landing .beats { margin: -6px 0 0; font: 13px/1.7 var(--mono); font-variant-caps: all-small-caps; letter-spacing: 0.08em; color: var(--muted); }
.landing .count { margin: -8px 0 0; font: 11px var(--mono); letter-spacing: 0.06em; color: var(--muted); font-variant-numeric: tabular-nums; }
.marker-row { gap: 8px; margin: -4px 0 2px; }
.marker-row .fine { margin: 0 4px 0 0; }
.marker-name { margin: 0 0 0 2px; color: var(--ink); }
.marker-chip { width: 22px; height: 22px; border: 2px solid var(--line); cursor: pointer; padding: 0; }
.marker-chip[aria-checked='true'] { border-color: var(--ink); outline: 2px solid var(--olive); outline-offset: 1px; }
@media (max-width: 480px) { .landing-mark { font-size: 40px; } }
`;

export function Onboarding() {
  const store = useStore();
  const busy = useSelect((s) => s.status === 'joining');
  const { ready, authenticated, login } = usePrivy();
  const signedIn = useSelect((s) => s.authenticated && !s.guest);
  const skinId = useSelect((s) => s.skinId);
  // The chip under the pointer or the focus ring, named beside the row; the chosen one when
  // there is none.
  const [hovered, setHovered] = useState<number | null>(null);

  // "N raider runs recorded": the ring's write counter (one per seated raider per settle) (`total` on `GET /api/leaderboard`), once
  // per mount. Nothing is shown until it lands, and Play never waits for it.
  const { total } = useLeaderboard();

  /**
   * Two steps, because the proof and the key have different owners: Privy's modal proves
   * who you are, then `store.signIn()` turns that into the token *and* the session keypair
   * the rest of the game signs with. The effect is what joins them — `login()` returns
   * void and only reports back by flipping `authenticated`, so nothing else would carry
   * the flow forward. It is also what picks up a returning tab, where Privy restores the
   * session and `authenticated` is already true by the time this card first renders.
   *
   * Identity only, on a returning tab: the page opens on this landing, not on the loader
   * — a seat used to follow the restore by itself, and the player was "building the
   * arena" before they could read a word. A seat follows a click: Play, or the Sign in
   * whose wallet popup just finished (`asked`), the one join a login implies.
   */
  const asked = useRef(false);
  useEffect(() => {
    if (!authenticated) return;
    void store.signIn().then(() => {
      if (asked.current) void store.join();
    });
  }, [authenticated, store]);

  const play = () => {
    if (authenticated) void store.signIn().then(() => store.join());
    else void store.playAsGuest();
  };
  /**
   * Already authenticated means the modal has nothing left to ask — this press is a retry
   * after a failed token fetch or a failed key unwrap — so it goes straight at `signIn`.
   */
  const connect = () => {
    asked.current = true;
    if (authenticated) void store.signIn().then(() => store.join());
    else login();
  };

  return (
    <>
      <style>{LANDING_CSS}</style>
      {/* Decorative: the header's h1 is the page's name in the tree. */}
      <p className="landing-mark" aria-hidden="true">
        HEARTROT
      </p>
      <section className="card landing">
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
        <p className="beats">move = a transaction · arrow = a transaction · 50 ms slots on magicblock</p>
        {total !== null && (
          <p className="count">
            {total.toLocaleString('en-US')} raider {total === 1 ? 'run' : 'runs'} recorded
          </p>
        )}
        {/* The marker, picked here: a seat is one click now, so the select screen no
            longer stands between the landing and the lobby, and the colour had nowhere
            to be chosen. Three chips, the same three the select still offers. */}
        <div className="row marker-row" role="radiogroup" aria-label="Your colour">
          <span className="fine">Your colour</span>
          {SKIN_COLORS.map((color, index) => (
            <button
              key={color}
              className="marker-chip"
              role="radio"
              aria-checked={index === skinId}
              aria-label={SKIN_NAMES[index]}
              title={SKIN_NAMES[index]}
              style={{ background: color }}
              onClick={() => store.setSkin(index)}
              onMouseEnter={() => setHovered(index)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(index)}
              onBlur={() => setHovered(null)}
            />
          ))}
          <span className="fine marker-name" aria-hidden="true">
            {SKIN_NAMES[hovered ?? skinId]}
          </span>
        </div>
        <div className="row">
          <button className="btn btn-primary" onClick={play} disabled={busy}>
            {busy ? 'Taking a seat…' : signedIn ? 'Play' : 'Play now'}
          </button>
          {!signedIn && (
            <button className="btn" onClick={connect} disabled={!ready || busy}>
              Sign in
            </button>
          )}
          <button className="link" onClick={() => store.showLeaderboard()}>
            Leaderboard
          </button>
        </div>
        <p className="fine">
          {signedIn
            ? 'Signed in. Your name stays on the leaderboard. Devnet only; nothing to buy and nothing to approve.'
            : 'Play now takes a seat as a guest. Signing in with a Solana wallet keeps your name on the leaderboard. Devnet only; nothing to buy and nothing to approve.'}
        </p>
      </section>
    </>
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
          : 'Finding the open arena · around three seconds.'}
      </p>
    </section>
  );
}
