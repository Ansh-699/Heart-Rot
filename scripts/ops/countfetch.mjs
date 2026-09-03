// Count outbound fetches during the Worker's sessionInit alone (background tasks excluded).
const real = globalThis.fetch; const hosts = {}; let n = 0; let counting = true;
globalThis.fetch = async (input, init) => {
  if (counting) { n++; const h = new URL(typeof input === 'string' ? input : input.url).host; hosts[h] = (hosts[h] ?? 0) + 1; }
  return real(input, init);
};
globalThis.__stopCounting = () => { counting = false; console.log(`FETCHES during sessionInit: ${n}`, JSON.stringify(hosts)); };
