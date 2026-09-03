/**
 * Signing gameplay transactions with the session key — decision D8.
 *
 * The session private key is non-extractable, so there are no raw secret bytes to hand
 * to a keypair-shaped signer; the only way to use it is `crypto.subtle.sign` plus
 * attaching the resulting 64 bytes to an already-built transaction. Under `@solana/kit`
 * a transaction's signatures *are* a plain `{ [address]: signature }` dictionary, so that
 * bridge is exactly the dictionary this signer returns. Nothing here ever sees the key
 * material.
 *
 * This is kit's `TransactionPartialSigner`, not a look-alike: it is aliased from the SDK
 * below rather than re-declared, because the one thing that matters about this module is
 * that `sendInstructions(rpc, createSessionSigner(session), ixs)` type-checks and keeps
 * type-checking. A hand-copied signer shape is how the app ends up unable to sign.
 *
 * It is the fee payer for every gameplay transaction and it holds zero SOL, because ER
 * fees are zero and the ER does not check the payer's balance (D6).
 *
 * Two rules from the research this signer cannot enforce but callers must keep:
 * send with `skipPreflight: true` (`sendInstructions` already does), and never let a
 * gameplay instruction move lamports in or out of this address on the ER — it is not a
 * delegated account, so the write is rejected with `InvalidAccountForFee` after execution.
 *
 * Consumers: the browser's gameplay send path — `enterGate`, `movePlayer` and `shoot`
 * are signed by this and by nothing else. The Worker never uses it; it signs with the
 * treasury key (see `worker/src/routes.ts`), and gameplay must not route through the
 * Worker.
 *
 * It signs one thing that is not a transaction: the guest proof (`guestProof`). A guest
 * has no Privy token, and the session key is the only secret the tab holds, so the
 * cold-path routes accept a signature by it over a timestamped challenge instead. The
 * challenge text lives here — `guestChallenge` — and the Worker imports it from this
 * package to verify, because a proof format written twice is the one-fact-twice defect
 * this repo keeps paying for.
 */

import {
  createSignableMessage,
  getBase64Decoder,
  type Address,
  type MessagePartialSigner,
  type SignatureBytes,
  type TransactionPartialSigner,
} from '@solana/kit';
import type { Session, SessionKey } from './session';

interface SigningSubtle {
  sign(algorithm: { name: string }, key: SessionKey, data: ArrayBufferView): Promise<ArrayBuffer>;
}

const subtle = (globalThis as unknown as { crypto: { subtle: SigningSubtle } }).crypto.subtle;

/**
 * Kit's partial signers — transactions for gameplay, messages for the guest proof —
 * exported under the name the app knows it by.
 */
export type SessionSigner = TransactionPartialSigner & MessagePartialSigner;

/**
 * One signer per `Session`. `loadOrCreateSession` is single-flight per page, so this
 * makes `createSessionSigner(state.sessionKey)` referentially stable — safe to call in
 * render or to put in a React dependency array without re-running the effect that owns
 * the send path.
 */
const signers = new WeakMap<Session, SessionSigner>();

/**
 * Wraps a session into the signer kit's transaction pipeline expects: pass it to
 * `setTransactionMessageFeePayerSigner` / `signTransactionMessageWithSigners`, which is
 * what `sendInstructions` does internally.
 *
 * Solana signatures are raw RFC 8032 Ed25519 over the serialized message, which is
 * exactly what WebCrypto produces, so this is a drop-in at the cryptographic level with
 * no encoding step in between.
 */
export function createSessionSigner(session: Session): SessionSigner {
  let signer = signers.get(session);
  if (signer !== undefined) return signer;

  const { address, keyPair } = session;
  const sign = async (bytes: ArrayBufferView): Promise<Readonly<Record<Address, SignatureBytes>>> => {
    const signature = await subtle.sign({ name: 'Ed25519' }, keyPair.privateKey, bytes);
    return Object.freeze({ [address]: new Uint8Array(signature) as SignatureBytes });
  };
  signer = {
    address,
    signTransactions: (transactions) =>
      Promise.all(transactions.map((transaction) => sign(transaction.messageBytes))),
    signMessages: (messages) => Promise.all(messages.map((message) => sign(message.content))),
  };
  signers.set(session, signer);
  return signer;
}

// ---------------------------------------------------------------------------
// Guest proof
// ---------------------------------------------------------------------------

/**
 * What a guest sends in place of `privyToken`: the session pubkey, a millisecond
 * timestamp, and the key's Ed25519 signature (base64) over `guestChallenge(pubkey, ts)`.
 * The Worker (`worker/src/auth.ts::identityFromGuest`) verifies the signature, bounds
 * `ts` to a five-minute window, and derives the identity from the pubkey alone — so a
 * captured proof is worth five minutes of being that guest and no more.
 */
export type GuestProof = {
  readonly pubkey: string;
  readonly ts: number;
  readonly signature: string;
};

/**
 * The text a guest signs, UTF-8 on both sides. Prefixed so that no transaction the
 * session key ever signs can be replayed as a proof, and no proof can be a transaction:
 * a message whose first byte is `h` (0x68) declares 104 required signatures, which no
 * packet-sized transaction can carry.
 */
export function guestChallenge(pubkey: string, ts: number): string {
  return `heartrot-guest:${pubkey}:${ts}`;
}

/** A fresh proof for right now. Built per request; it is cheaper than reasoning about expiry. */
export async function guestProof(session: Session): Promise<GuestProof> {
  const ts = Date.now();
  const [signatures] = await createSessionSigner(session).signMessages([
    createSignableMessage(guestChallenge(session.address, ts)),
  ]);
  const signature = signatures?.[session.address];
  if (!signature) throw new Error('The session key produced no signature.');
  return { pubkey: session.address, ts, signature: getBase64Decoder().decode(signature) };
}
