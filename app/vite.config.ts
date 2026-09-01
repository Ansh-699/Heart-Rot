import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * Fail a production build when the identity variable is missing, instead of shipping an
 * app that is not there.
 *
 * `src/main.tsx` deliberately renders a "Not configured" card when `VITE_PRIVY_APP_ID` is
 * unset, which is the right behaviour in dev. In a production build it is a trap: Vite
 * substitutes `undefined` for the missing variable, the `if (!PRIVY_APP_ID)` guard folds
 * to a constant, and rolldown dead-code-eliminates the entire else branch. `vite build`
 * then exits 0, prints no warning, and `dist/` contains the fallback card and none of the
 * game — verified: with the variable unset the bundle has zero occurrences of
 * `accountSubscribe`; with it set, it has them.
 *
 * A deploy that reads as "the game is broken" when one variable is unset is exactly the
 * failure this stops. Dev is left alone so `vite dev` still shows the friendly card.
 */
function requireIdentityEnv(): Plugin {
  return {
    name: 'heartrot:require-identity-env',
    config(config, { command, mode }) {
      if (command !== 'build') return;
      // config.root, not process.cwd(): this file is typechecked by app/tsconfig.json,
      // which has no node types, and Vite already knows its own root.
      if (loadEnv(mode, config.root ?? '.', 'VITE_').VITE_PRIVY_APP_ID) return;
      throw new Error(
        'VITE_PRIVY_APP_ID is unset, so this build would dead-code-eliminate the entire ' +
          'application and ship only the "Not configured" card.\n' +
          'Set it in app/.env (see app/.env.example) or in the deploy environment.',
      );
    },
  };
}

// `dist/` here is what `worker/wrangler.jsonc` publishes as static assets. Changing
// `build.outDir` means changing `assets.directory` there too.
export default defineConfig({
  plugins: [requireIdentityEnv(), react()],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    // In production `run_worker_first: ["/api/*"]` is the only path that reaches the
    // Worker. Mirroring exactly that one prefix in dev keeps the "gameplay never touches
    // the backend" rule true locally too — anything a dev accidentally routes through the
    // Worker will 404 here instead of working and then breaking on deploy.
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
