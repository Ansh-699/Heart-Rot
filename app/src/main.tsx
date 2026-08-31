/**
 * Mount point. Nothing else belongs here.
 *
 * This is also the seam for anything that must wrap the whole app: the Privy provider,
 * when it lands, goes around `<App />` here and calls `setAuthSource` from the store —
 * which is why the shell depends on a token-returning function and not on a Privy SDK.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { StoreProvider } from './state/store';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>,
);
