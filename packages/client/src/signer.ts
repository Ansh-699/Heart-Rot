/**
 * Signing gameplay transactions with the session key — decision D8.
 *
 * The session private key is non-extractable, so there are no raw secret bytes to hand
 * to a keypair-shaped signer; the only way to use it is `crypto.subtle.sign` plus
 * attaching the resulting 64 bytes to an already-built transaction. Under web3.js that
 * bridge is `tx.addSignature(pubkey, sig)`. Under `@solana/kit` — which is what this
 * package actually uses — a transaction's signatures *are* a plain
 * `{ [address]: signature }` dictionary, so the same bridge is the dictionary this
 * signer returns. Nothing here ever sees the key material.
 *
 * The shape below is kit's `TransactionPartialSigner`, structurally: pass it to
 * `setTransactionMessageFeePayerSigner` and `signTransactionMessageWithSigners` and it
 * works. It is the fee payer for every gameplay transaction, and it holds zero SOL,
 * because ER fees are zero and the ER does not check the payer's balance (D6).
 *
 * Two rules from the research this signer cannot enforce but callers must keep:
 * send with `skipPreflight: true`, and never let a gameplay instruction move lamports
 * in or out of this address on the ER — it is not a delegated account, so the write is
 * rejected with `InvalidAccountForFee` after execution.
 */

import type { Address, SignatureBytes, Transaction } from '@solana/kit';
import type { Session, SessionKey } from './session';

interface SigningSubtle {
  sign(algorithm: { name: string }, key: SessionKey, data: ArrayBufferView): Promise<ArrayBuffer>;
}

const subtle = (globalThis as unknown as { crypto: { subtle: SigningSubtle } }).crypto.subtle;

/** Kit's `SignatureDictionary`, spelled out so this module imports only stable types. */
type SignatureDictionary = Readonly<Record<Address, SignatureBytes>>;

export interface SessionSigner {
  readonly address: Address;
  signTransactions(transactions: readonly Transaction[]): Promise<readonly SignatureDictionary[]>;
}

/**
 * Wraps a session into the signer kit's transaction pipeline expects.
 *
 * Solana signatures are raw RFC 8032 Ed25519 over the serialized message, which is
 * exactly what WebCrypto produces, so this is a drop-in at the cryptographic level with
 * no encoding step in between.
 */
export function createSessionSigner(session: Session): SessionSigner {
  const { address, keyPair } = session;
  return {
    address,
    signTransactions(transactions) {
      return Promise.all(
        transactions.map(async (transaction) => {
          const signature = await subtle.sign(
            { name: 'Ed25519' },
            keyPair.privateKey,
            transaction.messageBytes,
          );
          return Object.freeze({ [address]: new Uint8Array(signature) as SignatureBytes });
        }),
      );
    },
  };
}
