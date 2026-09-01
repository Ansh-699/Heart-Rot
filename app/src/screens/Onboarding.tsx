/**
 * Onboarding — two cards.
 *
 * Card 1 is identity. Card 2 is a loader. That is the whole of it.
 *
 * **The funding card is deleted and must not come back.** ER transaction fees are zero and
 * the ER's vendored SVM has no `validate_transaction_fee_payer` at all, so the session
 * keypair needs no SOL on either layer (D6). A card asking a first-time player to acquire
 * devnet SOL would be asking them to solve a problem that does not exist — and every tier
 * of the ladder it replaced was near-useless anyway, since devnet's airdrop limit is one
 * per IP per 24 h and a whole lobby behind one CGNAT gets a single airdrop between them.
 * The game design spec's three-card §7 is superseded by `01-architecture.md` §7.2.
 *
 * **Privy is identity only, and that is a constraint rather than a preference.** It hands
 * back a DID and a JWT; it never signs a transaction. Its headless path runs
 * `initializeWalletProxy(15_000)` and a wallet recovery before the *first* signature of a
 * session — a 15-second ceiling, and under user-controlled recovery it throws with no
 * modal fallback — and signatures meter at $0.01 each above 50K/month, which twenty
 * players at gameplay rates burn through in under an hour. On a 400 ms tick none of that
 * is survivable. Every gameplay signature comes from the non-extractable WebCrypto key
 * `store.signIn()` resolves alongside the token.
 *
 * Both buttons below call the same function on purpose. Privy exposes email, social *and*
 * Phantom / Backpack / WalletConnect through one Wallet Standard connector list, so the
 * spec's "two paths" is one code path and two labels — and `@solana/wallet-adapter-*` is
 * not a dependency anywhere.
 *
 * This is the only file in `app/src` besides `main.tsx` that imports the Privy SDK, and it
 * imports exactly one hook: the modal is the one thing the store's `AuthSource` seam —
 * "give me a token" — cannot express. Everything downstream of the modal goes through the
 * store, so this card never handles a token itself.
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
  const enter = () => {
    if (authenticated) void store.signIn();
    else login();
  };

  return (
    <section className="card">
      <p className="eyebrow">A co-op raid that lives entirely on chain</p>
      <h2>Twenty of you. One boss. No health bar.</h2>
      <p className="lede">
        The boss is a shell, not a number. Break its crown, its heads and its thorn
        clusters — the thorns are what fire at you — and when enough of it is gone the
        chest vent opens and the face underneath becomes killable.
      </p>
      <p className="fine">
        Sign in once, so your seat and your damage survive a closed tab. After that there
        is no wallet popup during play, no seed phrase, and nothing to fund: your play key
        is generated inside this browser, holds zero SOL, and never leaves it.
      </p>
      <div className="row">
        <button className="btn btn-primary" onClick={enter} disabled={!ready || busy}>
          {busy ? 'Signing in…' : 'Enter with email or social'}
        </button>
        <button className="btn" onClick={enter} disabled={!ready || busy}>
          I already have a wallet
        </button>
      </div>
      <p className="fine">Devnet only. No token, no NFT, nothing to buy.</p>
    </section>
  );
}

/**
 * Card 2 — the wait while `POST /api/session/init` runs.
 *
 * It lives here because it is the second onboarding card, but it is rendered by
 * `CharacterSelect`: the screen is derived from `authenticated` and `match`, so the
 * moment sign-in succeeds the shell has already moved on, and the seat is not claimed
 * until a skin has been chosen (`skin_id` travels inside `claim_seat` and no route edits
 * it afterwards).
 *
 * The steps are named rather than hidden behind a spinner because this is genuinely five
 * to fifteen seconds of devnet round trips — creating three accounts, delegating them,
 * then waiting for the rollup to finish cloning all three — and an unlabelled spinner
 * that long reads as broken rather than as slow.
 */
const SEAT_STEPS = [
  'Checking your sign-in',
  'Finding the open arena, or paying for a new one',
  'Delegating it to the rollup and taking your seat',
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
        A few seconds. Devnet is slow; the rollup the raid actually runs on is not.
      </p>
    </section>
  );
}
