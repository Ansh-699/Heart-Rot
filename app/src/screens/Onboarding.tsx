/**
 * Onboarding — two cards, one action.
 *
 * Card 1 connects a browser wallet. Card 2 is the wait while the seat is created. That is
 * the whole of it.
 *
 * **Wallet detection only.** `main.tsx` configures Privy with `loginMethods: ['wallet']`
 * and embedded-wallet creation off on both chains, so there is no email path, no social
 * path and no seed-phrase-less onboarding to offer. A visitor with no Solana wallet
 * extension cannot play, and this card has to say so plainly rather than open a modal that
 * dead-ends in an empty list.
 *
 * **The funding card is deleted and must not come back.** ER transaction fees are zero and
 * the ER's vendored SVM has no `validate_transaction_fee_payer` at all, so the session
 * keypair needs no SOL on either layer. A card asking a first-time player to acquire devnet
 * SOL would be asking them to solve a problem that does not exist.
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
 * This is the only file in `app/src` besides `main.tsx` that imports the Privy SDK, and it
 * imports exactly one hook: the connect modal is the one thing the store's `AuthSource`
 * seam — "give me a token" — cannot express.
 */

import { useEffect } from 'react';
import { usePrivy } from '@privy-io/react-auth';

import { useSelect, useStore } from '../state/store';

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
    <section className="card">
      <p className="eyebrow">A co-op raid that lives entirely on chain</p>
      <h2>Twenty of you. One boss. No health bar.</h2>
      <p className="lede">
        The boss is a shell, not a number. Break its crown, its heads and its thorn clusters
        — the thorns are what fire at you — and when enough of it is gone the chest vent
        opens and the core underneath becomes killable.
      </p>
      <p className="fine">
        You need a Solana wallet extension in this browser — Phantom, Solflare or Backpack.
        There is no email or guest sign-in. The wallet proves who you are once and is never
        asked again: your play key is generated inside this browser, holds zero SOL, signs
        every move locally, and never leaves the tab.
      </p>
      <div className="row">
        <button className="btn btn-primary" onClick={connect} disabled={!ready || busy}>
          {busy ? 'Signing in…' : 'Connect your Solana wallet'}
        </button>
      </div>
      <p className="fine">
        Devnet only. No token, no NFT, nothing to buy, no transaction to approve after this
        one connect.
      </p>
    </section>
  );
}

/**
 * Card 2 — the wait while `POST /api/session/init` runs.
 *
 * It lives here because it is the second onboarding card, but it is rendered by
 * `CharacterSelect`: the screen is derived from `authenticated` and `match`, so the moment
 * sign-in succeeds the shell has already moved on, and the seat is not claimed until a
 * colour has been chosen (`skin_id` travels inside `claim_seat` and no route edits it
 * afterwards).
 *
 * The steps are named rather than hidden behind a spinner because this is a measured ~2.8 s
 * to the first usable ER write on devnet, and longer when the route has to pay for a fresh
 * arena. An unlabelled spinner that long reads as broken rather than as slow.
 */
const SEAT_STEPS = [
  'Checking your wallet sign-in',
  'Finding the open arena, or paying for a new one',
  'Delegating it to the rollup and claiming your seat',
] as const;

export function SeatLoader() {
  return (
    <section className="card" aria-busy="true">
      <p className="eyebrow">Taking a seat</p>
      <h2>Building your half of the arena.</h2>
      {/* A plain ordered list: the browser numbers it, and three lines of prose do not
          justify a class in the stylesheet. */}
      <ol className="fine">
        {SEAT_STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className="fine">
        Around three seconds, sometimes longer. Devnet is slow; the rollup the raid actually
        runs on answers in about 200 ms.
      </p>
    </section>
  );
}
