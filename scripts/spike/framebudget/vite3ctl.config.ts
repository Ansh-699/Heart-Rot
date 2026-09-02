// Throwaway: the SAME harness bundle with `Knight`'s memo removed at transform time, so the
// pre-fix control can be measured in the SAME sitting as the fix instead of against numbers
// taken hours earlier on a differently-loaded box. NO product file is modified — this is a
// one-line string replacement in the bundler, and it fails loudly if the source moves.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const FROM = 'memo(KnightBody, sameSeat)';
const TO = 'KnightBody'; // a plain function, stable identity, no comparison: the pre-fix tree

export default defineConfig({
  root: __dirname,
  plugins: [
    react(),
    {
      name: 'unmemo-knight',
      enforce: 'pre',
      transform(code: string, id: string) {
        if (!id.endsWith('/render/Knight.tsx')) return null;
        if (!code.includes(FROM)) throw new Error('unmemo-knight: anchor not found in Knight.tsx');
        return code.replace(FROM, TO);
      },
    },
  ],
  build: {
    target: 'es2022',
    outDir: 'dist3ctl',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { input: __dirname + '/index3.html' },
  },
});
