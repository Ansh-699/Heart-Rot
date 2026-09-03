// Throwaway (task: looks-right). Mounts the REAL app/src/App.tsx, same trick as
// scripts/spike/scenemount, so the screenshots below are the shipped renderer and not a
// redraw of it. Build output goes to tmpfs because the workstation disk is at 100%.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: __dirname,
  // The landing's clip and poster live in the app's public dir; without this they 404 here.
  publicDir: __dirname + '/../../../app/public',
  cacheDir: '/tmp/looksright-cache',
  plugins: [react()],
  resolve: { alias: { '@heartrot/client': __dirname + '/../../../packages/client/src/index.ts' } },
  build: { target: 'es2022', outDir: '/tmp/looksright-dist', emptyOutDir: true, sourcemap: false },
});
