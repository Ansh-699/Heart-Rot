/**
 * `@heartrot/client` — the hand-written SDK for the `heartrot` Pinocchio program.
 *
 * Pinocchio emits no IDL, so every byte on both sides of the boundary is written by hand:
 * `layout.ts` decodes accounts, `instructions.ts` encodes instructions, `pda.ts` derives
 * the addresses both of them name, `connection.ts` decides which chain a transaction is
 * even for, `session.ts` holds the browser's WebCrypto Ed25519 seat key and `signer.ts`
 * wraps it as a transaction signer. Imported by the browser SPA and by the Cloudflare
 * Worker, so nothing in here may assume either runtime.
 */

export * from './layout';
export * from './pda';
export * from './instructions';
export * from './connection';
export * from './session';
export * from './signer';
