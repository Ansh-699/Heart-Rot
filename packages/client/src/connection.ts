/**
 * The dual-connection pattern: base layer for setup and settlement, one pinned ER for
 * everything a match does while it is live.
 *
 * A MagicBlock deployment is three RPC surfaces, and conflating them is the documented
 * top failure mode:
 *
 *   - **Base layer** — a paid provider. `api.devnet.solana.com` answers a Worker's fetch
 *     with HTTP 403 while answering the identical POST from a shell with 200.
 *   - **Magic Router** — `getRoutes` and `getDelegationStatus` only. Plain
 *     `getLatestBlockhash` on the router returns an **ER** blockhash, so a base-layer
 *     transaction built through it signs against the wrong chain and dies. Nothing here
 *     ever fetches a blockhash from the router: `sendInstructions` takes its blockhash
 *     from the very endpoint it is about to send to, which makes that mistake unspellable.
 *   - **ER validator** — exactly one per match, named by `Arena.validator_identity`.
 *
 * The failure this module exists to prevent: reading a delegated account from the *wrong*
 * ER returns correctly-owned, plausible, silently **frozen** data — no error, no
 * WebSocket notification, no way to tell from the owner field. In a 20-player raid a
 * couple of players watch a motionless boss while everyone else fights, and it reads as a
 * game bug rather than a config bug. The only reliable discriminator is the delegation
 * record's validator authority matching the identity of the endpoint you are actually
 * talking to, so `connectMatch` and `assertErIdentity` check exactly that.
 *
 * The module's second job is that **every error a chain sends actually arrives**. That is
 * not free here: `sendInstructions` uses `skipPreflight` by design, so the only diagnostic
 * left is the one that comes back afterwards, and both layers of the stack were destroying
 * it — kit discards the ER's `-32003` message (see `surfaceServerErrors`) and
 * `JSON.stringify` throws on the bigints kit decodes a `TransactionError` into (see
 * `stringifyWithBigints`). Both were found on devnet, twice each. `decodeTransactionError`
 * finishes the job: an error that survives both of those still arrives as `Custom(8)`, and
 * a bare number is only half a diagnosis, so it is resolved against the generated
 * `errors.ts` table into `PlayerDead` — through the three different wire shapes the ER,
 * base devnet and kit each pick for the same value.
 */

import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  createTransactionMessage,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type Lamports,
  type RpcTransport,
  type Signature,
  type TransactionMessageBytesBase64,
  type TransactionSigner,
} from '@solana/kit';

import { HEARTROT_ERRORS, HEARTROT_ERROR_HIGHEST } from './errors';
import { SLOT_MS } from './layout';

// This package is shared by the browser and by workerd, so its tsconfig carries neither
// the DOM lib nor Node types. `fetch` and `setTimeout` are web standards present in both
// runtimes; declared locally rather than pulling a platform lib into a platform-free
// package. The router's two methods are not part of the Solana JSON-RPC surface kit
// models, so they cannot go through `createSolanaRpc`.
declare const fetch: (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
declare const setTimeout: (fn: () => void, ms: number) => unknown;

/** The Magic Router. Routing metadata only — never a blockhash, never a send. */
export const ROUTER_ENDPOINT = 'https://devnet-router.magicblock.app/';

export type HeartrotRpc = ReturnType<typeof createRpc>;

/** One entry of the router's `getRoutes` table. */
export type ErRoute = {
  identity: Address;
  fqdn: string;
  baseFee: number;
  blockTimeMs: number;
  countryCode: string;
};

/**
 * `getDelegationStatus`'s real shape. Note there is no `fqdn` key at all when the account
 * is undelegated — not `fqdn: null` — so `new URL(status.fqdn)` throws rather than
 * misbehaving. The SDK's own `.d.ts` declares only `isDelegated` and is wrong.
 */
export type DelegationStatus = {
  isDelegated: boolean;
  fqdn?: string;
  delegationRecord?: {
    /** The ER validator identity. This is the field that matters. */
    authority: Address;
    /** The account's original owning program. */
    owner: Address;
    delegationSlot: number;
    /** Lamports escrowed at delegation time, not the live balance. */
    lamports: number;
  };
};

/** Base layer plus the one ER a match is pinned to. */
export type MatchConnections = {
  base: HeartrotRpc;
  er: HeartrotRpc;
  erFqdn: string;
  validatorIdentity: Address;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * `JSON.stringify`, but it survives the `bigint`s kit puts in every decoded RPC value.
 *
 * Exported because the plain call is a landmine anywhere near kit: a `TransactionError`
 * from `getSignatureStatuses` is `{ InstructionError: [0n, { Custom: 6n }] }`, and
 * `JSON.stringify` throws `TypeError: Do not know how to serialize a BigInt` on it —
 * replacing the on-chain diagnostic with a TypeScript error dressed as a chain error. Two
 * devnet spikes lost their result to exactly that.
 *
 * Bigints come out **quoted** — `{"InstructionError":["0",{"Custom":"6"}]}`, not the
 * unquoted shape a validator prints. JSON has no bigint, so a replacer can only return a
 * string; emitting bare digits needs a sentinel-and-substitute pass that a real string
 * containing the sentinel then corrupts. The quotes are the honest rendering and the
 * error code is still right there, which is the whole job.
 */
export function stringifyWithBigints(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

/** What a `TransactionError` says once it has been read. Every field but `message` is best-effort. */
export type DecodedTransactionError = {
  /** Index of the failing instruction, when the failure was an `InstructionError`. */
  readonly instruction?: number;
  /** The `Custom(n)` code, when the failing instruction returned one. */
  readonly code?: number;
  /** The `HeartrotError` variant name for `code`, when this client knows it. */
  readonly name?: string;
  /** One line, always present, safe to show a human. */
  readonly message: string;
};

/** A member of a plain object, or `undefined` for anything that is not one. */
function memberOf(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

/**
 * A non-negative integer written in any of the three shapes this stack produces.
 *
 * That is the whole of F4: **the ER serialises `InstructionError`'s members as JSON
 * strings** — `InstructionError: ["0", { Custom: "8" }]` — where base devnet writes
 * numbers and kit's own decoder hands back `bigint`s. A decoder that reads one shape
 * silently fails to recognise the other two and reports every ER rule violation as an
 * opaque blob.
 */
function asCode(value: unknown): number | undefined {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/**
 * The refusal behind a thrown value, from whichever of this module's two throw sites
 * produced it. **This is what a `catch` should call**, not {@link decodeTransactionError}.
 *
 * {@link confirmSignature} throws with the DECODE already on `cause`;
 * {@link sendInstructions} throws whatever kit or the transport threw, undecoded. Callers
 * wrote `decodeTransactionError(e.cause ?? e)` to cover both — which re-decodes the
 * decode. `memberOf` finds no `InstructionError` on a decode, so the second pass returns
 * `{ message: <the JSON of the first pass> }` **with `code` gone**, and `code` is the
 * field every caller branches on. Measured, not reasoned: `sp_error_decode.ts` asserts it.
 *
 * The consequence was total. `App.tsx`'s gameplay path confirms one send at a time
 * specifically to catch `RateLimited` and `PlayerDead`, then tests
 * `decoded.code === undefined` and returns — so every confirm-time refusal it existed to
 * report was dropped on the floor, and the one it meant to filter (`BlockedByWall`) was
 * filtered by accident.
 */
export function refusalOf(error: unknown): DecodedTransactionError {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  if (isDecoded(cause)) return cause;
  return decodeTransactionError(cause !== undefined ? cause : error);
}

/**
 * Has this already been through {@link decodeTransactionError}?
 *
 * A raw `TransactionError` is a bare string or a single-variant object —
 * `{ InstructionError: … }`, `{ DuplicateInstruction: 0 }`, `{ BlockhashNotFound: {} }` —
 * and **none of them carries a `message`**. A decode always does. That is the whole test.
 */
function isDecoded(value: unknown): value is DecodedTransactionError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

/**
 * Read a `TransactionError` — from `getSignatureStatuses`, from a simulation, or off a
 * `cause` — and name the rule that refused, so a caller sees `PlayerDead` rather than
 * `Custom(8)`.
 *
 * Takes a **raw** error. Something caught from a promise goes through {@link refusalOf}
 * instead, which knows that half of them are already decoded.
 *
 * The `Custom(n) -> name` table is GENERATED from `programs/heartrot/src/error.rs` into
 * `errors.ts` by `tools/gen_errors.py`; the codes are wire ABI and a Pinocchio program
 * ships no IDL, so a table typed out here by hand is this project's signature defect —
 * one fact stored twice — waiting on the next appended variant.
 *
 * `code` is the field to branch on, never `message`. `BlockedByWall` in particular is
 * expected traffic — one per tick from a player holding a direction into a wall — and
 * exists as its own code precisely so a client can filter it instead of surfacing it.
 */
export function decodeTransactionError(err: unknown): DecodedTransactionError {
  const member = memberOf(err, 'InstructionError');
  if (!Array.isArray(member)) {
    // Not an instruction failure: `AccountInUse`, `BlockhashNotFound`, a bare string.
    return { message: typeof err === 'string' ? err : stringifyWithBigints(err) };
  }

  const instruction = asCode(member[0]);
  const detail: unknown = member[1];
  const code = asCode(memberOf(detail, 'Custom'));
  const info = code === undefined ? undefined : HEARTROT_ERRORS[code];

  let what: string;
  if (info !== undefined) {
    what = `${info.name} (Custom ${String(code)}) — ${info.message}`;
  } else if (code !== undefined) {
    what =
      code <= HEARTROT_ERROR_HIGHEST
        ? `Custom(${code}) — a retired heartrot code`
        : `Custom(${code}) — not a heartrot code: another program in the transaction, or a newer deploy than this client`;
  } else {
    // A named runtime variant: `PrivilegeEscalation`, `ProgramFailedToComplete`, …
    what = typeof detail === 'string' ? detail : stringifyWithBigints(detail);
  }

  return {
    instruction,
    code,
    name: info?.name,
    message: instruction === undefined ? what : `instruction ${instruction}: ${what}`,
  };
}

/** The `error` member of a JSON-RPC response, once it has been proven to be one. */
type JsonRpcErrorPayload = { readonly code: number; readonly message: string; readonly data?: unknown };

function jsonRpcErrorOf(response: unknown): JsonRpcErrorPayload | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  const error: unknown = (response as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, message, data } = error as { code?: unknown; message?: unknown; data?: unknown };
  if (typeof message !== 'string') return undefined;
  if (typeof code !== 'number' && typeof code !== 'bigint') return undefined;
  return { code: Number(code), message, data };
}

function rpcMethodOf(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const { method } = payload as { method?: unknown };
    if (typeof method === 'string') return method;
  }
  return 'rpc';
}

/**
 * Wrap a transport so a JSON-RPC error reaches the caller with the **server's own
 * message** attached.
 *
 * Kit maps `error.code` to a `SolanaError` and, for every code outside a small allow-list,
 * throws away `error.message`. The ER returns *all* of its cloner and transaction
 * verification failures as `-32003`, whose canonical Solana meaning is
 * `TransactionSignatureVerificationFailure` — so a transaction whose signature was
 * verified locally against its own public key reports "Transaction signature verification
 * failure", and the real cause ("Cloner error: … InsufficientFundsForRent",
 * "Address loading from lookup tables is disabled", "Error processing Instruction 0: …")
 * is gone. Forty minutes of one spike went into recovering a message the server had
 * already sent.
 *
 * This runs *before* kit's response transformer, which is the only place the raw payload
 * still exists. `cause` carries the whole `{ code, message, data }` for callers that want
 * to branch on it.
 */
function surfaceServerErrors(url: string, inner: RpcTransport): RpcTransport {
  return async <TResponse,>(config: Parameters<RpcTransport>[0]): Promise<TResponse> => {
    const response = await inner<TResponse>(config);
    const error = jsonRpcErrorOf(response);
    if (error !== undefined) {
      throw new Error(
        `${rpcMethodOf(config.payload)} on ${url}: ${error.message} (JSON-RPC ${error.code})`,
        { cause: error },
      );
    }
    return response;
  };
}

/**
 * One RPC constructor for both layers. `authorization` is for the paid base-layer
 * provider; the ER needs no auth and takes none.
 *
 * Every connection in this codebase is built here, which is why the server-message rescue
 * above is installed here rather than at any one call site: it covers `sendTransaction`,
 * `getFeeForMessage` and every read alike.
 */
export function createRpc(url: string, authorization?: string) {
  return createSolanaRpcFromTransport(
    surfaceServerErrors(
      url,
      createDefaultRpcTransport(
        authorization === undefined ? { url } : { url, headers: { Authorization: authorization } },
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function routerCall<T>(routerUrl: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(routerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) {
    throw new Error(`router ${method}: HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    result?: T;
    error?: { code: number; message: string };
  };
  if (body.error !== undefined) {
    throw new Error(`router ${method}: ${body.error.message} (${body.error.code})`);
  }
  if (body.result === undefined) {
    throw new Error(`router ${method}: no result`);
  }
  return body.result;
}

/**
 * The authoritative identity → endpoint table. Do not hardcode it, and key any health or
 * routing map by **identity**: the same validator appears under different hostnames in
 * `getRoutes` and in the status API.
 *
 * Also the router's liveness probe — `getHealth` and `getVersion` are both `-32601` there.
 */
export function getRoutes(routerUrl: string = ROUTER_ENDPOINT): Promise<ErRoute[]> {
  return routerCall<ErRoute[]>(routerUrl, 'getRoutes', []);
}

/**
 * Where does this account live? One account per call, passed as a bare string.
 * Also the client watchdog's re-verification step when `Arena.tick` stalls.
 */
export function getDelegationStatus(
  account: Address,
  routerUrl: string = ROUTER_ENDPOINT,
): Promise<DelegationStatus> {
  return routerCall<DelegationStatus>(routerUrl, 'getDelegationStatus', [account]);
}

// ---------------------------------------------------------------------------
// Pinning one ER per match
// ---------------------------------------------------------------------------

/**
 * Confirm that the endpoint behind `er` really is the validator the match was delegated
 * to. Call it once against the `erEndpoint` handed out by `/api/session/init`, before
 * subscribing to anything: a wrong-ER connection is otherwise indistinguishable from a
 * quiet game.
 */
export async function assertErIdentity(er: HeartrotRpc, expected: Address): Promise<void> {
  const { identity } = await er.getIdentity().send();
  if (identity !== expected) {
    throw new Error(`wrong ER: endpoint identity ${identity}, match is on ${expected}`);
  }
}

/**
 * Wait for a set of accounts to be delegated to `validatorIdentity` and to have been
 * cloned into that ER, then hand back both connections.
 *
 * Two phases, because `isDelegated: true` from the router can precede the ER actually
 * holding the account — that window is where an immediately-following transaction fails
 * with `InvalidWritableAccount`. The official example papers over it with a blind
 * `setTimeout(3000)`, which is both too slow for a joining player and not a guarantee.
 * Phase 2 polls the ER itself, which is the check that actually means the match is live.
 */
export async function connectMatch(cfg: {
  baseUrl: string;
  baseAuthorization?: string;
  routerUrl?: string;
  /** Every account the match delegates: Arena, Boss, Players. */
  accounts: readonly Address[];
  /** From `Arena.validator_identity`. Never resolve the ER independently. */
  validatorIdentity: Address;
  /** The `heartrot` program id — what a cloned account reads back as owned by. */
  ownerProgram: Address;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<MatchConnections> {
  const routerUrl = cfg.routerUrl ?? ROUTER_ENDPOINT;
  const timeoutMs = cfg.timeoutMs ?? 30_000;
  const pollMs = cfg.pollMs ?? 300;
  const deadline = Date.now() + timeoutMs;

  const routes = await getRoutes(routerUrl);
  const route = routes.find((r) => r.identity === cfg.validatorIdentity);
  if (route === undefined) {
    throw new Error(`no route for validator ${cfg.validatorIdentity}`);
  }

  const base = createRpc(cfg.baseUrl, cfg.baseAuthorization);
  const er = createRpc(route.fqdn);
  await assertErIdentity(er, cfg.validatorIdentity);

  // Phase 1 — the delegation record names our validator, for every account.
  for (;;) {
    const statuses = await Promise.all(
      cfg.accounts.map((a) => getDelegationStatus(a, routerUrl)),
    );
    const mismatch = statuses.findIndex(
      (s) => !s.isDelegated || s.delegationRecord?.authority !== cfg.validatorIdentity,
    );
    if (mismatch === -1) break;
    if (Date.now() >= deadline) {
      throw new Error(
        `delegation timeout: ${String(cfg.accounts[mismatch])} is not on ${cfg.validatorIdentity}`,
      );
    }
    await sleep(pollMs);
  }

  // Phase 2 — the ER has actually cloned them and reports our program as the owner.
  for (;;) {
    const infos = await Promise.all(
      cfg.accounts.map((a) => er.getAccountInfo(a, { encoding: 'base64' }).send()),
    );
    const missing = infos.findIndex((i) => i.value === null || i.value.owner !== cfg.ownerProgram);
    if (missing === -1) break;
    if (Date.now() >= deadline) {
      throw new Error(`ER clone timeout: ${String(cfg.accounts[missing])} not live on ${route.fqdn}`);
    }
    await sleep(pollMs);
  }

  return { base, er, erFqdn: route.fqdn, validatorIdentity: cfg.validatorIdentity };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * How long a cached blockhash is served before a refresh is kicked off behind the caller.
 * The ER's real window was probed at ~59 s (last accepted at age 58.0 s, first refused at
 * 60.2 s, on two runs), so 2 s runs at ~30x margin; base devnet's 150 blocks at 400 ms is
 * comparable.
 */
const BLOCKHASH_TTL_MS = 2_000;

/**
 * Past this age the caller *waits* for a new blockhash instead of being served the held
 * one. This is the only blocking fetch left in front of an input.
 *
 * It was 30 s, above a comment claiming only a run of failed background refreshes could
 * reach it. That was wrong, and it was the second of the two lags a two-player session
 * reported: nothing but a send or {@link warmBlockhash} triggers a refresh, so a client
 * that sends nothing for 30 s — standing in the lobby waiting for a friend — pays the
 * fetch on its very next keypress. Measured 81, 109, 97, 119 and 142 ms for that first
 * input, against 6-11 ms for one after a short idle.
 *
 * 50 s leaves ~9 s inside the probed ~59 s window for the fetch and the send it is for, so
 * a client now blocks only when its refreshes have genuinely been failing for most of a
 * minute — which is what the old comment claimed all along.
 */
const BLOCKHASH_MAX_AGE_MS = 50_000;

type CachedBlockhash = {
  lifetime: Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0];
  fetchedAt: number;
  /** Signatures already sent under this blockhash. See the dedupe in `sendInstructions`. */
  sent: Set<Signature>;
};

/**
 * Keyed by the `rpc` handle itself, not by URL. Each `createRpc` call makes a distinct
 * object, so an ER blockhash can never be served to a base-layer send — the failure
 * `connectMatch`'s docstring exists to prevent — without a URL-normalisation rule to get
 * wrong. A `WeakMap` also means a finished match's cache dies with its connections.
 */
const blockhashCache = new WeakMap<HeartrotRpc, CachedBlockhash>();

/**
 * In-flight refreshes, keyed the same way. The single-flight latch used to live on the
 * cache entry, which left both paths that have *no* usable entry — a cold cache, and one
 * past `BLOCKHASH_MAX_AGE_MS` — unguarded: two sends racing either one fetched two hashes,
 * and the loser's `sent` set was discarded with its entry.
 */
const blockhashInFlight = new WeakMap<HeartrotRpc, Promise<CachedBlockhash>>();

/**
 * Fetch a hash and install it, at most one fetch per `rpc` at a time.
 *
 * A refresh that comes back with the hash already held keeps that hash's `sent` set. The
 * ER's slot is 50 ms and `sendInstructions` now rotates about once per round trip
 * (~85 ms), so two refreshes landing inside one slot is ordinary traffic rather than a
 * curiosity — and a `sent` set reset there would let a repeated `shoot` past the dedupe as
 * a genuine duplicate signature.
 */
/** How long a blockhash fetch may hang before it is aborted and the single-flight latch released. */
const BLOCKHASH_FETCH_TIMEOUT_MS = 5_000;

function refreshBlockhash(rpc: HeartrotRpc): Promise<CachedBlockhash> {
  const running = blockhashInFlight.get(rpc);
  if (running !== undefined) return running;

  const pending = rpc
    .getLatestBlockhash()
    // BOUNDED, AND THAT IS LOAD-BEARING. The latch above is only released by one of the
    // two handlers below, so a fetch that never settles keeps it forever — and since the
    // blocking paths (`blockhashFor` past the max age, and the dedupe retry in
    // `sendInstructions`) join the latch rather than issuing their own, one hung request
    // would silently freeze every later send on this rpc: the fire key stops working,
    // then the character stops walking, with no error and a healthy feed. Only a reload
    // recovers it. Reproduced A/B against this file's own pre-rotation version, where the
    // same hung fetch cost nothing because both blocking paths always fetched for
    // themselves. Nothing else bounds it — `createDefaultRpcTransport` carries no timeout
    // — and the rotation below puts a request in flight after every send, so the odds of
    // owning the unlucky one went up ~8x with it. The abort takes the rejection handler,
    // which deletes the latch, and the next call retries for real. 5 s is far past the
    // 85 ms p50 round trip and far under any window a player would sit through.
    .send({ abortSignal: AbortSignal.timeout(BLOCKHASH_FETCH_TIMEOUT_MS) })
    .then(
      ({ value }) => {
        const prev = blockhashCache.get(rpc);
        const entry: CachedBlockhash = {
          lifetime: value,
          fetchedAt: Date.now(),
          sent: prev?.lifetime.blockhash === value.blockhash ? prev.sent : new Set(),
        };
        blockhashCache.set(rpc, entry);
        blockhashInFlight.delete(rpc);
        return entry;
      },
      (error: unknown) => {
        blockhashInFlight.delete(rpc);
        throw error;
      },
    );
  blockhashInFlight.set(rpc, pending);
  return pending;
}

/**
 * Start a refresh nobody waits for. The failure is swallowed on purpose: the held hash is
 * still valid, the next call retries, and an unhandled rejection here would kill a Worker
 * request.
 */
function kickRefresh(rpc: HeartrotRpc): void {
  // At most one rotation per ER slot. The hash only changes when the slot does, so a
  // second fetch inside the same 50 ms window buys nothing and cannot make a repeated
  // `shoot` unique either. Without it the rotation fires after every send: measured 1.3
  // -> 11.0 getLatestBlockhash per second per seat on a replayed fight, which at twenty
  // seats is ~195 extra requests a second landing on the same validator whose feed
  // stalls the rest of this diff exists to recover from. With it the rate is bounded by
  // the slot clock rather than by how fast the player moves.
  const held = blockhashCache.get(rpc);
  if (held !== undefined && Date.now() - held.fetchedAt < SLOT_MS) return;
  void refreshBlockhash(rpc).catch(() => undefined);
}

/**
 * A blockhash for `rpc` without a round trip on the critical path.
 *
 * This is the single largest win available on the submit half. `sendInstructions` used to
 * open with `await rpc.getLatestBlockhash().send()`, so every keypress was **two serial
 * round trips** to Singapore rather than one — measured at 265 ms end-to-end against
 * 135 ms with a cached hash, over three interleaved A/B runs of 130 samples per arm, and
 * again as +130.5/+143.4/+139.6/+167.1 ms on four runs of 224 sends.
 *
 * Stale-while-revalidate rather than a timer: a hash older than the TTL is still ~57 s
 * from expiry, so the send that notices serves the old one and lets the refresh land
 * behind it. No caller owns a timer; an idle match's freshness is `warmBlockhash`'s job.
 *
 * The TTL rotation is NOT issued here, even though this is where the age is read. It used
 * to be, and a kick fired from inside a send goes to the network BEFORE the send's own
 * fetch — kit reaches `fetch()` synchronously — so the first input after two idle seconds
 * queued its POST behind a `getLatestBlockhash` on the same connection: keydown to
 * `sendTransaction` p95 20.9 ms against 6.3 ms for a tap after one idle second, p50 2.6
 * against 1.8 (Sep 7 2026, forty of each, interleaved on one seat). `sendInstructions`
 * already rotates behind every send it makes, so the send needs nothing from here; the
 * idle client's rotation moved to {@link warmBlockhash}, the only other caller.
 */
async function blockhashFor(rpc: HeartrotRpc): Promise<CachedBlockhash> {
  const entry = blockhashCache.get(rpc);
  if (entry === undefined) return refreshBlockhash(rpc);
  if (Date.now() - entry.fetchedAt >= BLOCKHASH_MAX_AGE_MS) return refreshBlockhash(rpc);
  return entry;
}

/**
 * Keep `rpc`'s cache warm from outside a send, so an idle client never meets
 * `BLOCKHASH_MAX_AGE_MS`.
 *
 * Sends are the only other thing that refreshes it, which is exactly why a player who
 * stands still pays 81-142 ms on their next input (see that constant). `App.tsx` calls
 * this on attach and every 20 s while a match is linked — well inside the 50 s, and free
 * whenever the held hash is younger than `BLOCKHASH_TTL_MS`.
 *
 * Single-flight through {@link refreshBlockhash}, and it never rejects: a failed warm-up
 * is not the caller's problem. Awaiting the result is only useful to a test.
 */
export function warmBlockhash(rpc: HeartrotRpc): Promise<unknown> {
  // The TTL rotation, behind the caller: `blockhashFor` serves the held hash; past the max
  // age the two join the same single-flight fetch.
  const held = blockhashCache.get(rpc);
  if (held !== undefined && Date.now() - held.fetchedAt >= BLOCKHASH_TTL_MS) kickRefresh(rpc);
  return blockhashFor(rpc).catch(() => undefined);
}

/**
 * Build, sign and send. The blockhash comes from `rpc` — the same endpoint the
 * transaction is sent to — which is the whole of the base/ER discipline in one line.
 *
 * v0 message, **never** an address lookup table: the ER rejects a v0 transaction
 * carrying one outright, with no feature flag and no fallback (D18). Nothing here calls
 * `compressTransactionMessageUsingAddressLookupTables`, and nothing may.
 *
 * `skipPreflight` is unconditional. Preflight is a simulation by the node you submit to,
 * and the base layer's view of a delegated account is the stale committed copy owned by
 * the delegation program, so simulating an ER transaction anywhere rejects it before it
 * is sent. The cost is that a malformed transaction returns a signature and then fails
 * silently — use `confirmSignature` on any path where that matters.
 *
 * The blockhash is **cached** per `rpc` (see `blockhashFor`), which is what keeps a
 * keypress to one round trip instead of two. The cost of holding one is that a repeated
 * instruction becomes a byte-identical transaction with the same signature, and the node
 * refuses the repeat with `-32003 … already been processed` — so the repeat is detected
 * here and re-signed against a fresh hash rather than dropped. That re-fetch is *behind*
 * every send and only in front of a repeat that beats it home.
 */
export async function sendInstructions(
  rpc: HeartrotRpc,
  feePayer: TransactionSigner,
  instructions: readonly Instruction[],
): Promise<Signature> {
  const sign = async (entry: CachedBlockhash) =>
    signTransactionMessageWithSigners(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(feePayer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(entry.lifetime, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
      ),
    );

  let entry = await blockhashFor(rpc);
  let signed = await sign(entry);
  let signature = getSignatureFromTransaction(signed);

  if (entry.sent.has(signature)) {
    // `move` carries a monotonic u16 seq so it can never land here; `shoot` is
    // [tag, seat, dx, dy, tier] with no nonce, so any shooter who repeats an aim vector
    // produces the identical message. Free aim narrows this — a pointer shooter sends a
    // near-unique pair every time — but it does not close it: a standing player
    // auto-aiming at the same boss part repeats exactly. One extra round trip on a repeat
    // beats a silently dropped shot — App.tsx swallows a `-32003` with no custom code, so
    // the loss is invisible.
    //
    // This branch used to be the common case, not the rare one, because the only rotation
    // was here: measured keydown→POST p50 102 ms for 9 of 10 shots in a live fight, and
    // 216-245 ms when the ER was slower, against 6-16 ms for the first shot of a run. The
    // rotation below is what makes it rare; at most the first repeat of a run reaches it,
    // and even then `refreshBlockhash` usually hands back a fetch already in flight.
    //
    // ponytail: two repeats inside one 50 ms ER slot can still collide, since the refresh
    // may return the same hash. Fix properly by giving `shoot` a u16 nonce like `move`'s,
    // which needs a byte on the wire and so is a program change, not a client one.
    entry = await refreshBlockhash(rpc);
    signed = await sign(entry);
    signature = getSignatureFromTransaction(signed);
  }
  entry.sent.add(signature);

  // Rotate for the NEXT send, never for this one. The hash is the only thing that makes a
  // repeated `shoot` unique, so fetching it behind the send is what keeps the branch above
  // off the input path. Unconditional because nothing here can tell whether the next send
  // will repeat, and the cheaper-looking rules do not work: "rotate only after a reused
  // hash" just makes every second shot pay. No timer and no extra throttle either — the
  // single-flight latch already caps this at one fetch per round trip (~85 ms p50), about
  // one extra request per two sends at the 45 ms move pacing `controls.ts` holds. The
  // Worker pays one per send instead, on lifecycle routes that send once or twice per
  // request; nothing there is per-frame, and the crank runs on the ER's own scheduler.
  // The send's own fetch is handed to the network first; the rotation's follows it. Kit
  // reaches `fetch()` synchronously inside `.send()`, so the order here is the order on
  // the socket.
  const posted = rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: 'base64',
      skipPreflight: true,
    })
    .send();
  kickRefresh(rpc);
  await posted;
  return signature;
}

/**
 * Poll `getSignatureStatuses` until the transaction lands or errors.
 *
 * Polling, not `sendAndConfirmTransactionFactory`: that wants a WebSocket subscription,
 * and a Worker is the wrong place to hold one open. Never confirm against the router
 * either — `getSlot` is `-32601` there, which breaks every stock confirmation helper
 * silently.
 *
 * **Any non-null status with `err === null` is a landed transaction**, whatever
 * `confirmationStatus` says. It deliberately does not wait for `confirmed`: the ER is a
 * single validator with no consensus, so it may report `processed` for the whole life of
 * the transaction and a helper demanding more than that hangs until the timeout on every
 * ER send — a timeout error for a transaction that executed correctly, which is the
 * worst diagnostic in the set. A status entry exists only once a node has executed the
 * transaction; on the base layer the residual fork risk is bounded by the blockhash the
 * send already committed to, and every base-layer flow here is idempotent (tag 10 no-ops
 * on its own key, tag 15 refuses with `MatchNotRecorded` until tag 10 lands).
 */
export async function confirmSignature(
  rpc: HeartrotRpc,
  signature: Signature,
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<void> {
  const deadline = Date.now() + (opts?.timeoutMs ?? 30_000);
  const pollMs = opts?.pollMs ?? 400;
  for (;;) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status != null) {
      if (status.err !== null) {
        // `decodeTransactionError`, never `JSON.stringify`: kit decodes the instruction
        // index and a `Custom` code as bigints and the plain call throws on them — which
        // is how `InstructionError: [0, { Custom: 6 }]` reached two spikes as
        // `TypeError: Do not know how to serialize a BigInt`. The decoder also names the
        // rule, and `cause` carries the whole decode so a caller can branch on
        // `.code === 14` (`BlockedByWall`) without parsing the message.
        const decoded = decodeTransactionError(status.err);
        throw new Error(`transaction ${signature} failed: ${decoded.message}`, { cause: decoded });
      }
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`transaction ${signature} not confirmed within the timeout`);
    }
    await sleep(pollMs);
  }
}

/**
 * What will this instruction set cost on `rpc`? **Legacy message, deliberately.**
 *
 * The ER's `getFeeForMessage` rejects any v0 message with
 * `transaction verification error: Address loading from lookup tables is disabled`, even
 * when the message carries no lookup table — nothing in this codebase can produce one.
 * That refusal is specific to this one RPC method: the same validator accepts, executes
 * and finalises v0 *transactions* all day, which is why `sendInstructions` still builds v0
 * and only the probe goes legacy. Measured answers: ER 0, base layer 5000 lamports, for
 * the identical `move` instruction.
 *
 * Takes a fee-payer `Address` rather than a signer because nothing is signed — a fee is a
 * property of the message. `null` is the server's own answer for a blockhash it can no
 * longer find, not an error.
 */
export async function probeFee(
  rpc: HeartrotRpc,
  feePayer: Address,
  instructions: readonly Instruction[],
): Promise<Lamports | null> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const { messageBytes } = compileTransaction(
    pipe(
      createTransactionMessage({ version: 'legacy' }),
      (m) => setTransactionMessageFeePayer(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ),
  );
  const base64 = getBase64Decoder().decode(messageBytes) as TransactionMessageBytesBase64;
  const { value } = await rpc.getFeeForMessage(base64).send();
  return value;
}

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------

/**
 * The blockhash cache's four rules, against a counting stub instead of a chain. Every one
 * of them is a latency defect a player reported and nothing else in this repo can catch:
 * a real ER answers `getLatestBlockhash` too fast and too variably to tell "served from
 * cache" from "fetched again", and the ages that matter are 2 s and 50 s apart.
 *
 * An exported function rather than an import-time block, like `layoutSelfCheck`: this
 * package has no `import.meta.env`. Runnable the same way, from the repo root — but the
 * `.bin/esbuild` shim those two docstrings name is a broken symlink under this pnpm store
 * (node tries to parse the ELF and dies on `SyntaxError: Invalid or unexpected token`), so
 * reach the platform binary directly:
 *
 *   ES=$(ls -d node_modules/.pnpm/@esbuild+linux-x64@*)/node_modules/@esbuild/linux-x64/bin/esbuild
 *   $ES packages/client/src/connection.ts --bundle --format=esm --outfile=/tmp/conn.mjs
 *   node -e "import('/tmp/conn.mjs').then(m => m.connectionSelfCheck()).then(() => console.log('OK'))"
 */
export async function connectionSelfCheck(): Promise<void> {
  const ok = (cond: boolean, what: string): void => {
    if (!cond) throw new Error(`connection self-check: ${what}`);
  };

  let calls = 0;
  let blockhash = 'hash-a';
  const stub = {
    getLatestBlockhash: () => ({
      send: async () => {
        calls += 1;
        await sleep(0);
        return { value: { blockhash, lastValidBlockHeight: 1n } };
      },
    }),
  };
  const rpc = stub as unknown as HeartrotRpc;

  // A cold cache is single-flight: this is the path whose latch used to be on the entry
  // that does not exist yet, so both racers fetched.
  await Promise.all([warmBlockhash(rpc), warmBlockhash(rpc)]);
  ok(calls === 1, 'two concurrent cold warms fetch once');

  // Fresher than the TTL costs nothing at all.
  await warmBlockhash(rpc);
  ok(calls === 1, 'a hash inside the TTL is served without a fetch');

  const held = blockhashCache.get(rpc);
  ok(held !== undefined, 'the warm installed an entry');
  if (held === undefined) return;
  held.sent.add('sig-1' as Signature);

  // Between the TTL and the max age the caller keeps the held entry and the refresh runs
  // behind it. This is finding 2: at 30 s this branch used to block instead.
  held.fetchedAt = Date.now() - 30_000;
  ok((await warmBlockhash(rpc)) === held, 'a 30 s hash is served, not awaited');
  ok(calls === 2, 'and it kicked a refresh behind the caller');
  await sleep(1);

  // The refresh returned the same hash — same 50 ms slot — so the dedupe memory survives
  // it. Without this a repeated `shoot` gets a fresh empty set and sends a duplicate.
  ok(blockhashCache.get(rpc)?.sent.has('sig-1' as Signature) === true, 'same hash keeps `sent`');

  // A different hash is a different transaction, so the set starts over.
  blockhash = 'hash-b';
  const stale = blockhashCache.get(rpc);
  ok(stale !== undefined, 'still cached after the background refresh');
  if (stale === undefined) return;
  stale.fetchedAt = Date.now() - BLOCKHASH_MAX_AGE_MS;
  const fresh = (await warmBlockhash(rpc)) as CachedBlockhash;
  ok(calls === 3 && fresh !== stale, 'past the max age the caller waits for a new hash');
  ok(fresh.sent.size === 0, 'a new hash starts a new `sent` set');
}
