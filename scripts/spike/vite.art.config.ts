/**
 * Throwaway bundle harness (spec task: bundle).
 *
 * The app already inlines `assets/sprites/temple.svg` (Scene.tsx) and
 * `assets/sprites/parts/boss.svg` (Boss.tsx) as `?raw` string literals, so the art's real
 * cost is measured by *removing* it, not by adding it. This config is `app/vite.config.ts`
 * with one `load` hook that replaces chosen `*.svg?raw` modules with a stub of the same
 * shape (16 paths / 13 part groups) so the import-time asserts still pass and rolldown
 * still emits the same module graph.
 *
 *   STRIP=temple,boss  npx vite build -c ../scripts/spike/vite.art.config.ts   (from app/)
 *   STRIP=             ...control, byte-identical to `vite build` minus sourcemaps
 */
import { readFileSync } from 'node:fs';
import { defineConfig, mergeConfig, type Plugin } from 'vite';
import appConfig from '../../app/vite.config.ts';

const STRIP = (process.env.STRIP ?? '').split(',').filter(Boolean);
const TAG = process.env.LAZYBOSS ? (process.env.REL ? 'rel-lazyboss' : 'lazyboss') : process.env.REL ? 'rel' : STRIP.length ? STRIP.join('-') : 'full';

/** 16 `<path fill d>` so Scene.tsx's length assert holds; 13 `part-*` groups for Boss.tsx. */
const STUB_TEMPLE =
  '<svg viewBox="0 0 210 238">' +
  Array.from({ length: 16 }, (_, i) => `<path fill="#0000${i.toString(16)}${i.toString(16)}" d="M0 0h1v1h-1z"/>`).join('') +
  '</svg>';
const STUB_BOSS =
  '<svg viewBox="0 0 230 270">' +
  ['ground','legs','torso','core','thorn0','thorn1','thorn2','thorn3','crown','wolf_l','beast_r','mace','claws']
    .map((n) => `<g id="part-${n}"><path fill="#000000" d="M0 0h1v1h-1z"/></g>`).join('') +
  '</svg>';

/** LAZYBOSS=1: turn Boss.tsx's static `?raw` import into a dynamic one, so the boss art
 *  lands in its own chunk instead of the entry. Top-level await; `build.target` is es2022. */
function lazyBoss(): Plugin {
  return {
    name: 'spike:lazy-boss',
    enforce: 'pre',
    transform(code, id) {
      if (!process.env.LAZYBOSS || !id.endsWith('/src/render/Boss.tsx')) return null;
      const next = code.replace(
        /import BOSS_SVG from '([^']*boss\.svg\?raw)';/,
        "const BOSS_SVG: string = (await import('$1')).default;",
      );
      if (next === code) throw new Error('lazyBoss: Boss.tsx import not matched');
      return { code: next, map: null };
    },
  };
}

function stripArt(): Plugin {
  return {
    name: 'spike:strip-art',
    enforce: 'pre',
    load(id) {
      if (!id.includes('.svg')) return null;
      // REL=1: same SVG, subpath starts re-emitted relative (scripts/spike/art_relpath.py).
      if (process.env.REL) {
        const rel = id.includes('parts/boss.svg') ? '/tmp/art-rel/parts/boss.svg'
          : id.includes('temple.svg') ? '/tmp/art-rel/temple.svg' : null;
        if (rel) return `export default ${JSON.stringify(readFileSync(rel, 'utf8'))};`;
      }
      if (STRIP.includes('temple') && id.includes('temple.svg')) return `export default ${JSON.stringify(STUB_TEMPLE)};`;
      if (STRIP.includes('boss') && id.includes('boss.svg')) return `export default ${JSON.stringify(STUB_BOSS)};`;
      return null;
    },
  };
}

export default defineConfig(async (env) =>
  mergeConfig(typeof appConfig === 'function' ? await appConfig(env) : appConfig, {
    plugins: [lazyBoss(), stripArt()],
    build: { outDir: `dist-art-${TAG}`, sourcemap: false },
  }),
);
