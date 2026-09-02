import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    target: 'es2022',
    outDir: 'dist2',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { input: __dirname + '/index2.html' },
  },
});
