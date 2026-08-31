/**
 * HEARTROT session keypair — decision D8.
 *
 * A non-extractable WebCrypto Ed25519 key, generated in the browser and persisted in
 * IndexedDB. Non-extractable means the private half exists only as an opaque handle:
 * `exportKey` and `wrapKey` throw on it, so an XSS or a malicious extension cannot lift
 * 64 secret bytes off the origin in one shot the way it could out of `localStorage` —
 * it has to stay resident in the page to abuse the key at all. `CryptoKey` is
 * structured-cloneable, which is the only reason a key you cannot read can still be
 * stored, and is why this is IndexedDB rather than any simpler store.
 *
 * **This wallet is never funded and never needs to be.** ER transaction fees are zero
 * and the ER's SVM has no `validate_transaction_fee_payer` at all, so a key that has
 * never existed on any chain is a valid fee payer (D6). Sending SOL here would only
 * create a drainable balance on the least-protected key in the system. There is no
 * funding flow, and there should never be one.
 *
 * The session key is also not the durable player record — Privy identity is. IndexedDB
 * is evictable and per-origin, so `POST /api/session/init` is idempotent on `identity`
 * and re-registers whatever key this module hands back, first visit or fiftieth.
 *
 * This module never names a DOM type. `packages/client` compiles with `lib: ["ES2023"]`
 * and `types: []` because the Worker imports from it too, so the browser APIs used here
 * are reached through structural shims off `globalThis` instead.
 */

import { getAddressDecoder, type Address } from '@solana/kit';

// ---------------------------------------------------------------------------
// Platform shims
// ---------------------------------------------------------------------------

/**
 * Structural stand-in for a `CryptoKey`. Deliberately opaque: the whole point of the
 * key is that nothing can read it, so nothing here needs to describe more than enough
 * to tell a private half from a public one.
 */
export interface SessionKey {
  readonly type: string;
  readonly extractable: boolean;
}

/** Structural stand-in for a `CryptoKeyPair`. This is what lands in IndexedDB. */
export interface SessionKeyPair {
  readonly privateKey: SessionKey;
  readonly publicKey: SessionKey;
}

interface SessionSubtle {
  generateKey(
    algorithm: { name: string },
    extractable: boolean,
    usages: readonly string[],
  ): Promise<SessionKeyPair>;
  exportKey(format: 'raw', key: SessionKey): Promise<ArrayBuffer>;
}

interface IdbRequest<T> {
  readonly result: T;
  readonly error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

interface IdbOpenRequest extends IdbRequest<IdbDatabase> {
  onupgradeneeded: (() => void) | null;
}

interface IdbStore {
  get(key: string): IdbRequest<unknown>;
  put(value: unknown, key: string): IdbRequest<string>;
}

interface IdbDatabase {
  transaction(store: string, mode: 'readonly' | 'readwrite'): { objectStore(store: string): IdbStore };
  createObjectStore(name: string): unknown;
  close(): void;
}

interface IdbFactory {
  open(name: string, version: number): IdbOpenRequest;
}

const subtle = (globalThis as unknown as { crypto: { subtle: SessionSubtle } }).crypto.subtle;

// Absent in the Worker and in any non-browser import of this package; present but
// throwing on `open()` in some private-browsing modes, which `withStore` catches.
const idbFactory = (globalThis as unknown as { indexedDB?: IdbFactory }).indexedDB;

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface Session {
  /** Base58 session pubkey. Goes to `POST /api/session/init` and becomes `PlayerSlot.session_pubkey`. */
  readonly address: Address;
  /** The handle itself. `signer.ts` turns this into the transaction signer. */
  readonly keyPair: SessionKeyPair;
  /**
   * `false` when IndexedDB could not be read or written, so this key lives only until
   * the page unloads. Play still works — the key is valid and needs no funding — but the
   * player gets a new seat registration after every reload, so the UI should say so.
   */
  readonly persisted: boolean;
}

const DB_NAME = 'heartrot';
const DB_VERSION = 1;
const STORE = 'session';
const KEY = 'keypair';

let inFlight: Promise<Session> | undefined;

/**
 * Returns the persisted session key, generating and storing one on first visit.
 *
 * Safe to call repeatedly: one page load resolves exactly one keypair. React 19
 * double-invokes effects in development, and without this two mounts would race, each
 * generate a key, and the second `/api/session/init` would overwrite the first — the
 * losing tab then signs with a key the seat no longer recognises.
 *
 * ponytail: the single-flight is per page, not per origin. Two tabs open at once can
 * still both generate and both register, last write winning. Upgrade path is a
 * `BroadcastChannel` lock; until then the losing tab recovers on reload, since by then
 * the winner's key is the one in IndexedDB.
 */
export function loadOrCreateSession(): Promise<Session> {
  inFlight ??= resolveSession();
  return inFlight;
}

async function resolveSession(): Promise<Session> {
  const stored = await withStore('readonly', (store) => store.get(KEY));
  if (isSessionKeyPair(stored)) return toSession(stored, true);

  // Either a first visit, or storage was wiped/evicted under us. Both are the same job.
  const keyPair = await generate();
  const persisted = (await withStore('readwrite', (store) => store.put(keyPair, KEY))) !== undefined;
  return toSession(keyPair, persisted);
}

async function generate(): Promise<SessionKeyPair> {
  try {
    // extractable = false. The public half stays extractable regardless — that is
    // specified behaviour for a generated pair, and it is how the address below is read.
    return await subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
  } catch (cause) {
    // Otherwise this surfaces as "NotSupportedError: Unrecognized name", which sends
    // people looking for a bug in their own code.
    throw new Error(
      'This browser cannot generate Ed25519 keys. HEARTROT needs Chrome 137+, Firefox 129+ or Safari 17+.',
      { cause },
    );
  }
}

async function toSession(keyPair: SessionKeyPair, persisted: boolean): Promise<Session> {
  const raw = await subtle.exportKey('raw', keyPair.publicKey);
  return { address: getAddressDecoder().decode(new Uint8Array(raw)), keyPair, persisted };
}

/**
 * A stored value that is not a keypair is treated as absent, so a partial write or a
 * layout change from an older build regenerates rather than crashing on first signature.
 */
function isSessionKeyPair(value: unknown): value is SessionKeyPair {
  if (typeof value !== 'object' || value === null) return false;
  const { privateKey, publicKey } = value as Partial<SessionKeyPair>;
  return privateKey?.type === 'private' && publicKey?.type === 'public';
}

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

/**
 * Runs one request against the session store. Resolves `undefined` — never rejects —
 * when IndexedDB is unavailable, blocked or evicted, because none of those are reasons
 * to refuse to play: the key works whether or not it survives a reload.
 */
async function withStore<T>(
  mode: 'readonly' | 'readwrite',
  fn: (store: IdbStore) => IdbRequest<T>,
): Promise<T | undefined> {
  if (!idbFactory) return undefined;
  let db: IdbDatabase | undefined;
  try {
    db = await awaitRequest(openDb(idbFactory));
    return await awaitRequest(fn(db.transaction(STORE, mode).objectStore(STORE)));
  } catch {
    return undefined;
  } finally {
    // `close()` waits for outstanding transactions, so the write still commits.
    db?.close();
  }
}

function openDb(factory: IdbFactory): IdbOpenRequest {
  const request = factory.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    request.result.createObjectStore(STORE);
  };
  return request;
}

function awaitRequest<T>(request: IdbRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
