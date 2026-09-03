// The frame-budget harness build, parameterised so ONE config serves both arms of an A/B:
// `OUT_DIR` names the bundle and `MINIFY=0` keeps function names for the CPU profile
// `drive35.mjs` takes (a minified bundle profiles as `t`, `Ce` and `(anonymous)`). The
// control arm is not a source transform any more — `ab35.sh` builds it from a clean
// `git archive HEAD` tree, so the two arms differ only in the files copied in between.
import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The tree this config sits in. `@heartrot/client` is a pnpm workspace symlink into the
// REPO's packages/client, and Vite resolves symlinks to their real path — so a harness
// built inside an archived tree would silently take the working tree's decoder. Aliased
// to the tree's own copy, both arms decode with the layout they were archived with.
const TREE = path.resolve(__dirname, '../../..');

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  resolve: { alias: { '@heartrot/client': path.join(TREE, 'packages/client/src/index.ts') } },
  build: {
    target: 'es2022',
    outDir: process.env.OUT_DIR || 'dist35',
    emptyOutDir: true,
    sourcemap: false,
    minify: process.env.MINIFY === '0' ? false : 'esbuild',
    rollupOptions: { input: __dirname + '/index3.html' },
  },
});
