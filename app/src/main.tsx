/**
 * Mount point, and the one place identity is installed.
 *
 * The shell depends on a token-returning function (`AuthSource`), never on the Privy SDK.
 * This file is the whole seam: `PrivyProvider` wraps `<App />`, and Privy's standalone
 * `getAccessToken` becomes the argument to `setAuthSource`. Nothing else in `app/src`
 * imports `@privy-io/react-auth` except `screens/Onboarding.tsx`, which needs the login
 * modal itself.
 *
 * **Privy is identity only.** It hands back a DID and an ES256 JWT that the Worker verifies
 * against the public JWKS; it never signs a Solana transaction. Its headless signing path
 * pays a cross-origin iframe boot with a 15-second ceiling and throws with no modal
 * fallback under user-controlled recovery, and its signatures meter at $0.01 above
 * 50K/month — twenty players at gameplay rates burn that in under an hour. Every gameplay
 * signature comes from the non-extractable WebCrypto key `store.signIn()` resolves. Hence
 * `createOnLogin: 'off'` below: an embedded wallet we would never sign with is a liability
 * (a recovery prompt in the login flow) with no upside.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, getAccessToken } from '@privy-io/react-auth';

import App from './App';
import { setAuthSource, StoreProvider } from './state/store';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');
const root = createRoot(container);

/**
 * Public by construction — it is inlined into the bundle — but absent it there is no
 * sign-in at all, so this is a hard stop rather than a warning. It must be the same Privy
 * application as the Worker's `PRIVY_APP_ID`: the Worker builds its JWKS URL and its
 * expected `aud` from its own copy, so a mismatch rejects every token with `invalid privy
 * token` and nothing on screen says why.
 */
const PRIVY_APP_ID: string | undefined = import.meta.env.VITE_PRIVY_APP_ID;

if (!PRIVY_APP_ID) {
  // Loudly, and where a person will actually see it. Throwing here would leave a blank
  // page and a console line, which is how a misconfigured deploy reads as "the game is
  // broken" instead of as "one variable is unset".
  root.render(
    <section className="card">
      <p className="eyebrow">Not configured</p>
      <h2>Sign-in is unavailable.</h2>
      <p className="lede">
        <code>VITE_PRIVY_APP_ID</code> is unset, so this build has no identity provider and
        nobody can reach the game. Set it to the same Privy application as the Worker&rsquo;s{' '}
        <code>PRIVY_APP_ID</code> (see <code>.env.example</code>) and rebuild.
      </p>
    </section>,
  );
} else {
  /**
   * Called fresh for every cold-path request, never cached: Privy access tokens are
   * short-lived and the SDK refreshes them behind this call. A `null` means the session
   * lapsed — recoverable by signing in again, which is what the message says.
   *
   * Installing this is the load-bearing line of the file. Without it `authSource` stays at
   * the store's rejecting default, `store.signIn()` can never resolve, and `screenOf`
   * returns `'onboarding'` forever.
   */
  setAuthSource(async () => {
    const token = await getAccessToken();
    if (!token) throw new Error('Your sign-in expired. Sign in again.');
    return token;
  });

  root.render(
    <StrictMode>
      <PrivyProvider
        appId={PRIVY_APP_ID}
        config={{
          loginMethods: ['email', 'google', 'wallet'],
          appearance: { walletChainType: 'solana-only' },
          embeddedWallets: {
            ethereum: { createOnLogin: 'off' },
            solana: { createOnLogin: 'off' },
          },
        }}
      >
        <StoreProvider>
          <App />
        </StoreProvider>
      </PrivyProvider>
    </StrictMode>,
  );
}
