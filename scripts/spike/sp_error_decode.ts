/**
 * The one offline spike: `decodeTransactionError` against the three wire shapes a
 * `TransactionError` actually arrives in.
 *
 * Its siblings all talk to devnet. This one needs no chain and no keys, because the
 * defect it guards is pure decoding — the ER serialises `InstructionError`'s members as
 * JSON **strings** (`["0", { Custom: "8" }]`), base devnet writes **numbers**, and kit's
 * own decoder hands back **bigints**. Reading one shape and not the others turns every
 * ER rule violation back into the opaque blob F4 was about, and `tsc` cannot see it:
 * the values arrive as `unknown` from the RPC.
 *
 * It also pins the generated table to the program: `Custom(8)` must still be
 * `PlayerDead`. Re-run `python3 tools/gen_errors.py` and this fails the moment a
 * variant is renumbered.
 *
 * Run (the esbuild bin is a native executable, not a node script — invoke it directly):
 *   ./node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     scripts/spike/sp_error_decode.ts --bundle --platform=node --format=esm --outfile=/tmp/sp_error_decode.mjs
 *   node /tmp/sp_error_decode.mjs   # prints `sp_error_decode: ok`, exits non-zero on any drift
 */

import { strict as assert } from 'node:assert';

import { decodeTransactionError, HEARTROT_ERROR_HIGHEST } from '../../packages/client/src/index';

// The ER: every member a JSON string.
const er = decodeTransactionError({ InstructionError: ['0', { Custom: '8' }] });
assert.equal(er.instruction, 0);
assert.equal(er.code, 8);
assert.equal(er.name, 'PlayerDead');
assert.match(er.message, /^instruction 0: PlayerDead \(Custom 8\) — /);

// Base devnet: numbers.
const base = decodeTransactionError({ InstructionError: [1, { Custom: 14 }] });
assert.equal(base.code, 14);
assert.equal(base.name, 'BlockedByWall');

// Kit's decoder: bigints. This is the shape `JSON.stringify` used to throw on.
const kit = decodeTransactionError({ InstructionError: [0n, { Custom: 6n }] });
assert.equal(kit.code, 6);
assert.equal(kit.name, 'WrongPhase');

// A named runtime variant carries no code, and must still read as itself.
const runtime = decodeTransactionError({ InstructionError: [0, 'ProgramFailedToComplete'] });
assert.equal(runtime.code, undefined);
assert.equal(runtime.message, 'instruction 0: ProgramFailedToComplete');

// Not an instruction failure at all.
assert.equal(decodeTransactionError('AccountInUse').message, 'AccountInUse');
assert.equal(decodeTransactionError({ BlockhashNotFound: {} }).message, '{"BlockhashNotFound":{}}');

// 16 is retired; anything above the high-water mark is not ours.
assert.match(decodeTransactionError({ InstructionError: [0, { Custom: 16 }] }).message, /retired/);
assert.match(
  decodeTransactionError({ InstructionError: [0, { Custom: HEARTROT_ERROR_HIGHEST + 1 }] }).message,
  /not a heartrot code/,
);

console.log('sp_error_decode: ok');
