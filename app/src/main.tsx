/**
 * Mount point, and the one place identity is installed.
 *
 * The shell depends on a token-returning function (`AuthSource`), never on a Privy SDK, so
 * this file is the whole seam: the provider — when the SDK lands — wraps `<App />` below
 * and its `getAccessToken` becomes the argument to `setAuthSource`. Nothing else changes.
 *
 * Until then the placeholder source below is installed instead. It is deliberately *not*
 * the store's default: that default rejects unconditionally, which leaves the app stuck on
 * the onboarding screen with no way forward even in local development. A source that
 * resolves lets the client run end to end; the token it mints is plainly marked as
 * unsigned, so the Worker's JWKS check rejects it loudly rather than accepting a forgery.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { setAuthSource, StoreProvider } from './state/store';
import './styles.css';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * PLACEHOLDER — substitute the Privy React SDK before any public deployment.
 *
 * To do that: add `@privy-io/react-auth` to `app/package.json`, wrap `<App />` in
 * `<PrivyProvider appId={PRIVY_APP_ID}>`, and replace this whole block with
 * `setAuthSource(getAccessToken)` from `usePrivy()`. `VITE_PRIVY_APP_ID` and the Worker's
 * `PRIVY_APP_ID` must be the same application (see `.env.example`); the Worker builds its
 * JWKS URL from its copy, so a mismatch fails every route with an auth error.
 */
const PRIVY_APP_ID: string | undefined = import.meta.env.VITE_PRIVY_APP_ID;

/**
 * A stable subject for this browser. Privy's DID is stable across reloads and the Worker
 * derives the seat's identity from it, so a fresh random value per page load would hand
 * out a new identity on every refresh and make dev sessions untraceable.
 */
function devSubject(): string {
  const KEY = 'heartrot.dev-subject';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

/** Token shape: `unsigned-dev.<app id>.<subject>`. Never verifies; never meant to. */
function devToken(): string {
  if (!PRIVY_APP_ID) {
    throw new Error('Sign-in is unconfigured: set VITE_PRIVY_APP_ID (see .env.example).');
  }
  return `unsigned-dev.${PRIVY_APP_ID}.${devSubject()}`;
}

setAuthSource(async () => devToken());

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>,
);

// ---------------------------------------------------------------------------
// Self-check
//
// The failure this guards against is the one that just shipped: an auth source that never
// resolves, which shows up four screens later as "stuck on onboarding" rather than as an
// error here. Dev-only, so a production build pays nothing for it.
// ---------------------------------------------------------------------------

if (import.meta.env.DEV) {
  if (!PRIVY_APP_ID) {
    console.warn('heartrot: VITE_PRIVY_APP_ID is unset — sign-in will fail.');
  } else {
    const token = devToken();
    if (!token || devToken() !== token) {
      throw new Error('main self-check: auth source must return a stable, non-empty token');
    }
  }
}
