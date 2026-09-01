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
 */

import type { Address, SignatureBytes, TransactionPartialSigner } from '@solana/kit';
import type { Session, SessionKey } from './session';

interface SigningSubtle {
  sign(algorithm: { name: string }, key: SessionKey, data: ArrayBufferView): Promise<ArrayBuffer>;
}

const subtle = (globalThis as unknown as { crypto: { subtle: SigningSubtle } }).crypto.subtle;

/** Kit's partial signer, exported under the name the app knows it by. */
export type SessionSigner = TransactionPartialSigner;

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
  signer = {
    address,
    signTransactions(transactions) {
      return Promise.all(
        transactions.map(async (transaction) => {
          const signature = await subtle.sign(
            { name: 'Ed25519' },
            keyPair.privateKey,
            transaction.messageBytes,
          );
          return Object.freeze({ [address]: new Uint8Array(signature) as SignatureBytes }) as
            Readonly<Record<Address, SignatureBytes>>;
        }),
      );
    },
  };
  signers.set(session, signer);
  return signer;
}
