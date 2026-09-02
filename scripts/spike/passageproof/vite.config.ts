import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
