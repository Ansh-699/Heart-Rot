// Throwaway (task: ux-walk). Same mounting trick as scripts/spike/looksright.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: __dirname,
  cacheDir: '/tmp/uxwalk-cache',
  plugins: [react()],
  resolve: { alias: { '@heartrot/client': __dirname + '/../../../packages/client/src/index.ts' } },
  build: { target: 'es2022', outDir: '/tmp/uxwalk-dist', emptyOutDir: true, sourcemap: false },
});
