// Throwaway. Builds the REAL app/src/render tree as a standalone page so the frame budget
// is measured on product code, not a mock of it. No product file is touched.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
