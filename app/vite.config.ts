import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `dist/` here is what `worker/wrangler.jsonc` publishes as static assets. Changing
// `build.outDir` means changing `assets.directory` there too.
export default defineConfig({
  plugins: [react()],
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
