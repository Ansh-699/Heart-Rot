// The ONE platform global this package touches. `lib` here is ES2023 with no DOM on
// purpose (`tsconfig.json`), but `connection.ts` bounds its blockhash fetch with
// `AbortSignal.timeout`, which every browser since 2022 and Node since 17.3 provide and
// no ECMAScript lib declares. Declared here rather than by pulling `DOM` in: the point of
// the lib line is that nothing else platform-specific can creep into the shared client.
interface AbortSignal {
  readonly aborted: boolean;
}
declare const AbortSignal: {
  timeout(milliseconds: number): AbortSignal;
};
