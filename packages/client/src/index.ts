/**
 * `@heartrot/client` — the hand-written SDK for the `heartrot` Pinocchio program.
 *
 * Pinocchio emits no IDL, so every byte on both sides of the boundary is written by hand:
 * `layout.ts` decodes accounts, `instructions.ts` encodes instructions, `pda.ts` derives
 * the addresses both of them name, `connection.ts` decides which chain a transaction is
 * even for, `session.ts` holds the browser's WebCrypto Ed25519 seat key and `signer.ts`
 * wraps it as a transaction signer. Imported by the browser SPA and by the Cloudflare
 * Worker, so nothing in here may assume either runtime.
 *
 * `map.ts`, `hitboxes.ts` and `errors.ts` are GENERATED — `tools/gen_map.py`,
 * `tools/gen_hitboxes.py` and `tools/gen_errors.py` compile them, and their Rust twins
 * where there is one, out of `assets/map/arena.json`, `assets/sprites/hitboxes.json` and
 * `programs/heartrot/src/error.rs`. Never hand-edit them; re-run the tool.
 *
 * TWO INVARIANTS, both of which have already cost a build:
 *
 * 1. EVERY `src/*.ts` gets a line below. `app/` and `worker/` import this barrel and
 *    nothing else, so a module that is not listed here does not exist to them — that is
 *    how a `vite build` once exited 1 with an empty dist. Adding a file to `src/` without
 *    adding its line is the whole bug, and this is the whole check:
 *      cd packages/client/src && for f in *.ts; do m="${f%.ts}"; [ "$m" = index ] ||
 *        grep -q "from './$m'" index.ts || echo "MISSING $f"; done
 *
 * 2. Names must stay unique ACROSS modules. `export *` is a wildcard, not a merge: two
 *    modules exporting one name is ambiguous. TypeScript reports that as TS2308 right
 *    here rather than silently dropping the name, so `tsc --noEmit` in this package is
 *    the guard — but the fix belongs in whichever module chose the colliding name, never
 *    in an explicit re-export bandaging over it. Constants that genuinely belong to two
 *    modules (`MAP_TILES`, `CRANK_PROGRAM_ID`) live in exactly one and are imported by
 *    the other, the same single-source rule the Rust side follows.
 *
 * Deliberately a wildcard barrel and not a curated list of names: the curated version has
 * to be edited for every new constant, decoder and instruction builder, and the failure
 * mode of forgetting is the same broken import — with far more chances to forget.
 */

export * from './layout';
export * from './pda';
export * from './instructions';
export * from './connection';
export * from './errors';
export * from './session';
export * from './signer';
export * from './map';
export * from './tag';
export * from './hitboxes';
export * from './aim';
export * from './body';
