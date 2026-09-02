// Throwaway: measure dist bundle bytes raw/gzip/brotli, split into the cold-cache
// critical path (index.html + entry + modulepreload + css) and everything else.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { join } from 'node:path';

const dist = process.argv[2] ?? 'app/dist';
const html = readFileSync(join(dist, 'index.html'));
const crit = new Set(['index.html']);
for (const m of html.toString().matchAll(/(?:src|href)="\/assets\/([^"]+)"/g)) crit.add('assets/' + m[1]);

const files = [];
const walk = (d, p = '') => {
  for (const e of readdirSync(join(dist, d), { withFileTypes: true })) {
    const rel = p ? `${p}/${e.name}` : e.name;
    if (e.isDirectory()) walk(join(d, e.name), rel);
    else if (!rel.endsWith('.map')) files.push(rel);
  }
};
walk('.');

const br = (b) => brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
const acc = { all: [0, 0, 0, 0], critical: [0, 0, 0, 0], lazy: [0, 0, 0, 0] };
const add = (k, r, g, b) => { acc[k][0]++; acc[k][1] += r; acc[k][2] += g; acc[k][3] += b; };
for (const f of files) {
  const buf = readFileSync(join(dist, f));
  const g = gzipSync(buf, { level: 9 }).length, b = br(buf);
  add('all', buf.length, g, b);
  add(crit.has(f) ? 'critical' : 'lazy', buf.length, g, b);
}
const kb = (n) => (n / 1024).toFixed(1).padStart(9);
console.log('set          files       raw      gzip    brotli   (KiB)');
for (const [k, v] of Object.entries(acc))
  console.log(k.padEnd(10), String(v[0]).padStart(5), kb(v[1]), kb(v[2]), kb(v[3]));
console.log('\nmaps (not shipped by wrangler? check):',
  (readdirSync(join(dist, 'assets')).filter(f => f.endsWith('.map'))
    .reduce((s, f) => s + statSync(join(dist, 'assets', f)).size, 0) / 1048576).toFixed(1), 'MiB');
