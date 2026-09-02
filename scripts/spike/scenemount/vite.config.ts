// Throwaway. Mounts the REAL app/src/App.tsx (Privy lives in main.tsx, not App) so the
// portal-remount question is answered against product code rather than a mock of it.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  resolve: { alias: { '@heartrot/client': __dirname + '/../../../packages/client/src/index.ts' } },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
