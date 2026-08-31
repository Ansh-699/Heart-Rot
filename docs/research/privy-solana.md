# Privy embedded wallets for Solana — HEARTROT research

Researched 2026-08-31. Every version number below was read off npm or out of the
published package tarball on that date, not from memory.

Evidence policy for this doc: anything marked **[source]** was read from the actual
published package (`npm pack` + read the `.d.ts` / minified bundle). Anything marked
**[docs]** came from docs.privy.io. Where the two disagree, the package wins and I say so.

---

## 1. TL;DR for HEARTROT

1. **Privy is not needed in the gameplay hot path, and must not be in it.** The frozen
   design already says a browser-generated session keypair signs all gameplay txs. Keep
   that. Every Privy signing call is either an iframe postMessage round trip (legacy
   on-device wallets) or an HTTPS round trip to `api.privy.io` (TEE wallets). Neither
   survives a 400ms tick loop, and Privy bills per signature above the free tier.
2. **The zero-popup promise is achievable**: `embeddedWallets: {showWalletUIs: false}`.
   Verified in the shipped bundle, not just docs. *One line, with one condition* — headless
   signing still runs an iframe-proxy boot (15 s ceiling on first call) and a silent
   `recoverEmbeddedWallet`, so recovery must stay Privy-managed or the call throws instead of
   prompting. See §6.3a.
3. **Custom RPC (the ER endpoint) is a non-issue for signing.** `signTransaction` never
   touches an RPC — verified in the bundle. It takes `Uint8Array` in, gives `Uint8Array`
   out, and you broadcast wherever you like. Only `signAndSendTransaction` needs an RPC,
   and you can point `solana:devnet` at any URL you want, including the ER.
4. **The Cloudflare Worker side does not need a Privy SDK at all.** A Privy access token
   is a plain ES256 JWT. `jose` + `importSPKI` against the Dashboard's static verification
   key is ~10 lines and makes **zero** network calls; `createRemoteJWKSet` against the public
   JWKS endpoint is the alternative. `@privy-io/node@0.34.0` supports Workers (verified: no
   `node:` builtin imports at all) if you ever want the SDK.
5. **Biggest footgun found:** `useSignTransaction` and `useSignAndSendTransaction`
   default `chain` to `"solana:mainnet"`. A devnet project that forgets to pass
   `chain: 'solana:devnet'` will silently sign against the wrong chain config.

---

## 2. Exact pinned versions (npm, 2026-08-31)

| package | version | last publish | note |
|---|---|---|---|
| `@privy-io/react-auth` | **3.39.0** | current `latest` | the browser SDK you want |
| `@privy-io/node` | **0.34.0** | 2026-08-28 | current server SDK, **supports Cloudflare Workers** |
| `@privy-io/server-auth` | 1.32.5 | **2025-09-17** | effectively abandoned — last stable is ~11 months old, last beta 2025-10-03. Do not start here. |
| `@privy-io/js-sdk-core` | 0.72.1 | 2026-08-31 | transitive, pinned by react-auth |
| `@privy-io/api-types` | 0.20.0 | — | transitive |
| `@privy-io/expo` | 0.71.1 | 2026-08-31 | not needed |
| `@solana/kit` | 8.2.0 | — | peer dep of react-auth (`>=3.0.3`) |
| `@solana/web3.js` | 1.98.4 | — | what Anchor/BOLT still uses |
| `@solana-program/system` | 0.14.0 | — | peer dep of react-auth (`>=0.8.0`) |

`@privy-io/react-auth@3.39.0` peer dependencies, verbatim from npm **[source]**:

```json
{
  "@abstract-foundation/agw-client": "^1.0.0",
  "@farcaster/mini-app-solana": "^1.0.0",
  "@solana-program/memo": ">=0.8.0",
  "@solana-program/system": ">=0.8.0",
  "@solana-program/token": ">=0.6.0",
  "@solana/kit": ">=3.0.3",
  "permissionless": "^0.2.47",
  "react": "^18 || ^19",
  "react-dom": "^18 || ^19"
}
```

**All Solana peers are declared `optional: true` in `peerDependenciesMeta`** **[source, verified
2026-08-31]** — `@solana/kit`, `@solana-program/{system,token,memo}`, plus `permissionless`,
`@abstract-foundation/agw-client`, `@farcaster/mini-app-solana`. You only have to install
`@solana/kit` + `@solana-program/system` if you actually import `@privy-io/react-auth/solana`.
Installing `@privy-io/react-auth` alone does not drag them in.

Note what is **not** there: `@solana/web3.js`. Privy v3 has fully moved to `@solana/kit`.
It bundles `viem@2.56.0`, `styled-components`, `@base-ui/react`, `@headlessui/react`,
`@coinbase/wallet-sdk`, `@walletconnect/*` and `x402` as hard dependencies — this is a
heavy client SDK, budget for it in a pixel game bundle.

`@privy-io/node@0.34.0` dependencies **[source]** — notably light and Workers-safe:

```json
{
  "@hpke/chacha20poly1305": "^1.7.1",
  "@hpke/core": "^1.7.5",
  "@noble/curves": "^1.9.7",
  "@noble/hashes": "^1.8.0",
  "@scure/base": "^1.2.5",
  "canonicalize": "^2.1.0",
  "jose": "^6.1.0",
  "lru-cache": "^11.1.0",
  "svix": "^1.92.2"
}
```

No `@solana/web3.js` in the new server SDK (the old `server-auth` did depend on it).

---

## 3. Solana support level: real, first-class, but kit-shaped

`@privy-io/react-auth/solana` is a real subpath export with its own type surface. From
`dist/dts/solana.d.ts` **[source]**, the exported hooks are exactly:

```
useCreateWallet, useExportWallet, useFundWallet, useImportWallet,
useSignAndSendTransaction, useSignMessage, useSignTransaction,
useSolanaFundingPlugin, useSolanaLedgerPlugin, useStandardWallets, useWallets
```

Privy models both embedded wallets and external wallets (Phantom, Backpack,
WalletConnect) behind the **Wallet Standard** interface, so `useWallets()` returns a
uniform `ConnectedStandardSolanaWallet[]` and the same `signTransaction` call works for
an embedded wallet and for Phantom. That is genuinely useful for HEARTROT's
"embedded OR wallet-connect" requirement — one code path, not two.

Supported chains are a closed set. From the shipped bundle **[source]**:

```js
["solana:mainnet","solana:devnet","solana:testnet"]
```

and the CAIP-2 constants Privy uses internally **[source]**:

```js
let ae = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";  // mainnet
let re = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";  // devnet
```

---

## 4. Provider setup (verbatim)

From the Privy Solana quickstart **[docs]**, adjusted below for devnet in §4.1:

```tsx
import {PrivyProvider} from '@privy-io/react-auth';
import {toSolanaWalletConnectors} from '@privy-io/react-auth/solana';
import {createSolanaRpc, createSolanaRpcSubscriptions} from '@solana/kit';

export function Providers({children}: {children: ReactNode}) {
  return (
    <PrivyProvider
      appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID}
      config={{
        solana: {
          rpcs: {
            'solana:mainnet': {
              rpc: createSolanaRpc('https://api.mainnet-beta.solana.com'),
              rpcSubscriptions: createSolanaRpcSubscriptions('wss://api.mainnet-beta.solana.com')
            }
          }
        },
        appearance: {
          showWalletLoginFirst: true,
          walletChainType: 'solana-only'
        },
        loginMethods: ['wallet', 'email'],
        externalWallets: {
          solana: {
            connectors: toSolanaWalletConnectors()
          }
        },
        embeddedWallets: {
          createOnLogin: 'all-users'
        }
      }}
    >
      {children}
    </PrivyProvider>
  );
}
```

Solana-specific embedded wallet auto-creation **[docs]**:

```tsx
<PrivyProvider
    appId="your-privy-app-id"
    config={{
        embeddedWallets: {
            solana: {
                createOnLogin: 'users-without-wallets',
            },
        },
    }}
>
    {children}
</PrivyProvider>
```

`createOnLogin` accepts `'all-users' | 'users-without-wallets' | 'off'` **[source, docs]**.

### 4.1 The config HEARTROT actually wants

```tsx
config={{
  loginMethods: ['email', 'google', 'wallet'],
  appearance: {walletChainType: 'solana-only'},
  externalWallets: {solana: {connectors: toSolanaWalletConnectors()}},
  embeddedWallets: {
    solana: {createOnLogin: 'users-without-wallets'},
    showWalletUIs: false,            // <-- the zero-popup switch
  },
  solana: {
    rpcs: {
      'solana:devnet': {
        rpc: createSolanaRpc(process.env.NEXT_PUBLIC_BASE_RPC!),
        rpcSubscriptions: createSolanaRpcSubscriptions(process.env.NEXT_PUBLIC_BASE_WS!),
      },
    },
  },
}}
```

The RPC config type **[source]**:

```ts
solana?: {
    rpcs?: Partial<Record<SolanaChain, {
        rpc: Rpc<SolanaRpcApi>;
        rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
        blockExplorerUrl?: string;
    }>>;
};
```

**The key is constrained to `SolanaChain`, the value is not.** You cannot invent a
`"solana:magicblock-er"` key, but the URL inside `solana:devnet` can be literally
anything — including a MagicBlock ER or router endpoint. That is the whole answer to
"can Privy sign against a custom RPC".

**CORRECTED 2026-08-31 — the hosted-RPC fallback is opt-in, not automatic.**
`defaultSolanaRpcsPlugin` is a *plugin you must register yourself*; `PrivyProvider` passes
`configPlugins: config.plugins` and registers nothing by default **[source,
`index-BMVqHT_T.mjs`; `PrivyClientConfig.plugins?: Array<... | DefaultSolanaRpcsPlugin>` in
`types-C8c3jEOh.d.ts:1724`]**. You get Privy's hosted RPCs only if you write:

```tsx
import {defaultSolanaRpcsPlugin} from '@privy-io/react-auth/solana';
config={{plugins: [defaultSolanaRpcsPlugin()]}}
```

and then they are **[source, `dist/esm/solana.mjs`, re-read 2026-09-01]** — note the plugin
supplies **websocket subscriptions too**, not just HTTP:

```js
"solana:mainnet": {rpc: createSolanaRpc(`https://solana-mainnet.rpc.privy.systems?privyAppId=${encodeURIComponent(appId)}`),
                   rpcSubscriptions: createSolanaRpcSubscriptions(`wss://solana-mainnet.rpc.privy.systems?...`)}
"solana:devnet":  {rpc: createSolanaRpc(`https://solana-devnet.rpc.privy.systems?privyAppId=${encodeURIComponent(appId)}`),
                   rpcSubscriptions: createSolanaRpcSubscriptions(`wss://solana-devnet.rpc.privy.systems?...`)}
```

The merge order is `config.solana.rpcs[chain] ?? plugin?.getDefaultRpcs({appId})[chain] ?? null`
**[source, `useSolanaRpcClient-hNOxPuXt.mjs`, verbatim]** — config always wins, plugin is a
fallback, and with neither you get the throw below.

There is no default for `solana:testnet`. With **no** `solana.rpcs` and **no** plugin — the
default state — `useSolanaRpcClient` throws
`` Error(`No RPC configuration found for chain ${chain}`) `` **[source]**. For HEARTROT this is
good news: do not register the plugin, and Privy has no RPC of its own to accidentally route
through (see §12.3).

---

## 5. Getting a signer, and the exact input shape

The docs quickstart is slightly misleading here. What the type declarations actually
say **[source, `dist/dts/solana.d.ts`]**:

```ts
type SignTransactionInput = {
    transaction: Uint8Array;
    wallet: ConnectedStandardSolanaWallet;
    chain?: SolanaChain;
    options?: SolanaSignTransactionOptions & {
        uiOptions?: SendTransactionModalUIOptions;
    };
};
type SignTransactionOutput = {
    signedTransaction: Uint8Array;
};

type SignAndSendTransactionInput = {
    transaction: Uint8Array;
    wallet: ConnectedStandardSolanaWallet;
    chain?: SolanaChain;
    options?: SolanaSignAndSendTransactionOptions & {
        uiOptions?: SendTransactionModalUIOptions;
        sponsor?: boolean;
        optimisticBroadcast?: boolean;
        skipSimulation?: boolean;
    };
};
type SignAndSendTransactionOutput = {
    signature: Uint8Array;
};
```

**`transaction` is a raw `Uint8Array` of serialized transaction bytes.** It is not a
kit `Transaction` object and not a web3.js `Transaction`. This is excellent news for
HEARTROT: it means the SDK is serialization-format-agnostic, and a `VersionedTransaction`
built by Anchor / the BOLT SDK on `@solana/web3.js@1.98.4` can be handed to Privy with
`tx.serialize()`. You do **not** have to migrate BOLT tooling to `@solana/kit` just to
use Privy.

**Verified empirically, not by reading types** (2026-08-31, `@solana/kit@8.2.0` +
`@solana/web3.js@1.98.4`, both installed and run). Privy's internal splice does
`getTransactionDecoder().decode(bytes)` → mutate `.signatures[address]` →
`getTransactionEncoder().encode(...)`. I round-tripped real transactions through exactly that:

| input | decode | round-trip byte-identical | payer present in `.signatures` |
|---|---|---|---|
| `VersionedTransaction` (v0), 217 B | ok | **yes** | yes |
| legacy `Transaction` (what `anchor .transaction()` returns), 215 B | ok | **yes** | yes |

and a spliced signature re-read correctly via `VersionedTransaction.deserialize()`. Both
transaction versions work. Two practical notes from the same run:

- `VersionedTransaction.serialize()` works on an **unsigned** tx. Legacy
  `Transaction.serialize()` **throws** unless you pass
  `{requireAllSignatures: false, verifySignatures: false}`. Use that, or build v0.
- An address that is not a signer slot returns `false` from the `in` check — confirmed — so
  the splice is a silent no-op. See gotcha 6.

Kit-flavoured construction, from the docs **[docs]**:

```tsx
import {pipe, createSolanaRpc, getTransactionEncoder, createTransactionMessage} from '@solana/kit';

const transaction = pipe(
  createTransactionMessage({version: 0}),
  // Configure your transaction...
  (tx) => new Uint8Array(getTransactionEncoder().encode(tx))
);
```

Signing **[docs]**:

```tsx
import {useSignTransaction, useWallets} from '@privy-io/react-auth/solana';

const {signTransaction} = useSignTransaction();
const {wallets} = useWallets();
const selectedWallet = wallets[0];

const signedTransaction = await signTransaction({
  transaction: transaction,
  wallet: selectedWallet
});
```

Creating a Solana embedded wallet **[docs]**:

```tsx
import {useWallets, useCreateWallet} from '@privy-io/react-auth/solana';

const {createWallet} = useCreateWallet();
const wallet = await createWallet({createAdditional: true});
```

Note the return type from the declaration is `Promise<{wallet: Wallet}>` **[source]**,
i.e. `const {wallet} = await createWallet()`, which does not match the docs snippet above.
Trust the type.

Signing a message **[docs]**:

```tsx
import {useSignMessage, useWallets} from '@privy-io/react-auth/solana';

const {signMessage} = useSignMessage();
const {wallets} = useWallets();
const signature = await signMessage({
  message: new TextEncoder().encode('Hello from Privy!'),
  wallet
});
```

---

## 6. Signing WITHOUT a confirmation prompt — verified in source

This is the load-bearing question for HEARTROT's "zero wallet popups" promise, so I read
the shipped code rather than trusting the docs.

### 6.1 The switch

**[docs]** three levels, in precedence order:

1. per-call `options.uiOptions.showWalletUIs`
2. `PrivyProvider` `config.embeddedWallets.showWalletUIs`
3. Dashboard: *Configuration > Authentication > Advanced > "Disable confirmation modals"*

```tsx
<PrivyProvider
  config={{
    embeddedWallets: {
      showWalletUIs: false
    }
    /** ... */
  }}
>
  <App />
</PrivyProvider>
```

The type declaration confirms the fallback semantics **[source]**:

> Override any settings for the embedded wallet's UI to show or hide the wallet UIs.
> If true, wallet UIs will always be shown. If false, wallet UIs will always be hidden.
> **If not set, the default behavior will match the server configuration.**

And the actual config normaliser, verbatim **[source, `dist/esm/context-97je72pd.mjs`]**:

```js
showWalletUIs: config?.embeddedWallets?.showWalletUIs ?? serverConfig.enforce_wallet_uis ?? true,
mode:          serverConfig.embedded_wallet_config.mode,
```

So the **final fallback is `true` (modal shown)** — not headless. And note `mode` is read
straight off the server config: the legacy-vs-TEE choice is Dashboard-only, there is no
client override.

### 6.2 The actual decision function

Deminified from `dist/esm/index-BMVqHT_T.mjs` **[source]**:

```js
isHeadlessSigning = ({showWalletUIs}) =>
    hideWalletUIsRef.current
      ? hideWalletUIsRef.current
      : showWalletUIs !== undefined
        ? !showWalletUIs
        : !config.embeddedWallets.showWalletUIs
```

### 6.3 The two signing backends

Deminified from `dist/esm/useWallets-DNK5FqjA.mjs` **[source]** — this is the embedded
Solana wallet's `signTransaction`:

```js
signTransaction: async ({transaction, options, chain = "solana:mainnet", address}) => {
  const wallet = getEmbeddedWallet(user, address);
  if (wallet?.walletClientType !== 'privy')
    throw new PrivyError("Wallet is not a Privy wallet", undefined, EMBEDDED_WALLET_NOT_FOUND);
  const isTee = isUnifiedWallet(wallet);

  async function doSign(txBytes) {
    if (isTee) {
      // TEE ("unified stack") wallet: HTTPS RPC call to Privy's API
      const res = await walletRpc(privy, signWithUserSigner, {
        chain_type: 'solana',
        method: 'signTransaction',
        params: {transaction: base64.fromBytes(txBytes), encoding: 'base64'},
        wallet_id: wallet.id
      });
      if (res.data && 'signed_transaction' in res.data && res.data.signed_transaction != null)
        return {signedTransaction: new Uint8Array(base64.toBytes(res.data.signed_transaction))};
      throw Error("Failed to sign transaction");
    }
    // legacy on-device wallet: sign the transaction MESSAGE bytes in the Privy iframe
    // as a raw message, then splice the signature into the tx signature slot
    const {signature} = await signMessage({
      message: getMessageBytes(txBytes),
      address,
      options: {...options, uiOptions: {...options?.uiOptions, showWalletUIs: false}}
    });
    return {signedTransaction: spliceSignatureIntoTransaction(txBytes, address, signature)};
  }

  return isHeadlessSigning({showWalletUIs: options?.uiOptions?.showWalletUIs})
    ? doSign(transaction)                                // no modal at all
    : new Promise(/* ... opens "EmbeddedWalletConnectingScreen" modal ... */);
}
```

### 6.3a Headless is not unconditional — the precondition the docs omit

**Added 2026-08-31.** For a **legacy** on-device wallet, `doSign` delegates to `signMessage`,
and that function's inner body runs this **before** any signing, in the headless branch too
**[source, `useWallets-DNK5FqjA.mjs`, function `ue()`]**:

```js
const accessToken = await client.getAccessToken();
if (!accessToken) throw Error("User must be authenticated to use their embedded wallet.");
const proxy = walletProxy ?? await initializeWalletProxy(15_000);   // 15s timeout
if (!proxy) throw Error("Failed to initialize embedded wallet proxy.");
if (!await recoverEmbeddedWallet({address})) throw Error("Unable to connect to wallet");
```

Consequences, and they matter for the "zero wallet popups" promise:

- The **first** headless signature of a session pays a cross-origin iframe boot, with a
  **15-second** ceiling. It is not "tens of ms" cold; it is tens of ms only once warm.
- `recoverEmbeddedWallet` must succeed **without UI**. That holds for Privy-managed
  (automatic) recovery. If the app configures user-controlled recovery (password / passkey /
  cloud backup), recovery needs user input — and with `showWalletUIs: false` there is **no
  modal to fall back to**, so the call throws `"Unable to connect to wallet"` instead of
  prompting. Zero popups then means zero signatures.
- **Decision for HEARTROT:** leave recovery on Privy-managed ("automatic recovery"). The session
  key does the work, so the user never needs portable custody of the embedded wallet.

The **TEE** `signTransaction` path skips the proxy entirely and calls `api.privy.io` directly,
so it has no iframe boot — but it pays an internet RTT on every signature instead.

**Scope note added 2026-09-01.** Everything in this §6.3a is the **legacy on-device** path.
Since §12.5 now (correctly) accepts the TEE default, none of it is on HEARTROT's path: the TEE
`signTransaction` above never calls `signMessage`, so no proxy boot, no `recoverEmbeddedWallet`,
no 15 s ceiling. Keep the section because it is the deciding argument against ever enabling
on-device to chase Privy's advertised 5 ms signing (§13) — you would trade an internet RTT for a
cold-start cliff plus a recovery mode that throws with no modal fallback under
`showWalletUIs: false`.

### 6.3b What the two backends prove

- Headless signing is a real code path, not a docs claim. `doSign` is called directly
  with no modal, no user gesture (subject to §6.3a).
- **`signTransaction` never constructs or touches an RPC client.** The `chain` argument
  is only carried into the modal path. So signing is fully decoupled from which network
  you eventually broadcast to.
- There are two wallet backends with very different latency. The legacy on-device wallet
  signs inside a cross-origin iframe (postMessage round trip, tens of ms). The TEE
  "unified stack" wallet makes a network call to `api.privy.io` (a real internet RTT,
  plus Privy rate limits). **Neither is fast enough for a 400ms tick loop with 20
  players.**

The mode is app-level **[source]**:

```ts
export type EmbeddedWalletMode = 'legacy-embedded-wallets-only' | 'user-controlled-server-wallets-only';
```

`user-controlled-server-wallets-only` is the TEE stack.

**CORRECTED 2026-09-01 — TEE is the default; legacy/on-device is the gated one.** An earlier
draft of this doc had it backwards. Privy's own security docs say so plainly
**[docs, `/security/wallet-infrastructure/advanced/user-device`]**:

> By default, Privy uses trusted execution environments (TEEs) [...] As an advanced setting,
> Privy also enables wallets to be reassembled **directly on user devices**.
> On-device execution is an advanced configuration. **Please reach out to enable this setting.**
> [...] If you have on-device execution enabled, you will see "On-device" as the Wallet
> environment [...] **Otherwise, your app uses TEE execution.**

Corroborated in the bundle: the placeholder `serverConfig` the SDK ships with has
`mode: "user-controlled-server-wallets-only"` **[source, `context-97je72pd.mjs`]**. So a brand-new
Privy app is TEE, and choosing legacy means opening a Privy support thread. See the corrected
decision in §12.5.

Also note the direction of travel is one-way **[docs, `/recipes/tee-wallet-migration-guide`]**:
*"This is a one-way change, and on-device execution is disabled once migration occurs."*
`useMigrateWallets` migrates on-device → TEE only. There is no TEE → on-device path.

---

## 7. Session signers / delegated actions (server signs for the user)

Client-side hooks **[source, `dist/dts/index.d.ts`]** — note `useSessionSigners` is now
deprecated:

```ts
/** @deprecated in favor of useSigners */
interface UseSessionSignersInterface {
    addSessionSigners: (args: {address: string; signers: SessionSignerInput}) => Promise<{user: User}>;
    removeSessionSigners: (args: {address: string}) => Promise<{user: User}>;
}

interface UseSignersInterface {
    addSigners: (args: {address: string; signers: SignerInput}) => Promise<{user: User}>;
    removeSigners: (args: {address: string}) => Promise<{user: User}>;
}
declare const useSigners: () => UseSignersInterface;
```

```ts
type SessionSignerInput = {
    signerId: string;
    policyIds?: string[];
}[];
```

Client usage **[docs]**:

```tsx
import {useLogin} from '@privy-io/react-auth';
import {useSigners} from '@privy-io/react-auth';

const {addSigners} = useSigners();
const {login} = useLogin({
    onComplete: (user, isNewUser) => {
        if (isNewUser) {
          await addSigners({
            address: user.wallet.address,
            signers: [{
                signerId: 'insert-key-quorum-id-from-step-2',
                policyIds: []
            }]
         });
        }
    }
})
```

Generating the app's authorization key **[docs]**:

```sh
openssl ecparam -name prime256v1 -genkey -noout -out private.pem && \
openssl ec -in private.pem -pubout -out public.pem
```

The authorization key is a P-256 keypair; the app signs each API request and passes the
signature in the `privy-authorization-signature` header **[docs]**.

Server-side Solana signing surface **[source, `public-api/services/solana.d.ts`]**:

```ts
export declare class PrivySolanaService {
    signMessage(walletId: string, input: SignMessageInput): Promise<SolanaSignMessageRpcResponseData>;
    signTransaction(walletId: string, input: SignTransactionInput): Promise<SolanaSignTransactionRpcResponseData>;
    signAndSendTransaction(walletId: string, input: SignAndSendTransactionInput): Promise<SolanaSignAndSendTransactionRpcResponseData>;
}
```

All three accept `transaction: string | Uint8Array` and auto-encode. Server usage **[docs]**:

```javascript
import {
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  TransactionMessage,
} from '@solana/web3.js';

const walletPublicKey = new PublicKey(wallet.address);
const instruction = SystemProgram.transfer({
  fromPubkey: walletPublicKey,
  toPubkey: new PublicKey(recipientAddress),
  lamports: amount,
});

const message = new TransactionMessage({
  payerKey: walletPublicKey,
  instructions: [instruction],
  recentBlockhash,
});

const transaction = new VersionedTransaction(message.compileToV0Message());

const {hash} = await privy.wallets().solana().signAndSendTransaction('insert-wallet-id', {
  caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', // Mainnet
  transaction: Buffer.from(transaction.serialize()).toString('base64'),
  sponsor: true,
});
```

Important asymmetry found in the request types **[source]**:

```ts
export interface SolanaSignAndSendTransactionRpcInput {
    caip2: AppsAPI.Caip2;        // REQUIRED
    method: 'signAndSendTransaction';
    params: {encoding: 'base64'; transaction: string};
    // ... sponsor, optimistic_broadcast, sponsor_options, reference_id
}

export interface SolanaSignTransactionRpcInput {
    method: 'signTransaction';   // NO caip2 field at all
    params: {encoding: 'base64'; transaction: string};
    address?: string;
    chain_type?: 'solana';
    wallet_id?: string;
}
```

So the **server-side `signTransaction` is completely network-agnostic** — no chain id,
no RPC. If you ever need a Worker to sign a user's transaction for the ER, that is the
call to use, and you broadcast the returned bytes to the ER yourself. `signAndSendTransaction`
requires a `caip2` that Privy's backend must know how to route; `Caip2` is typed as a bare
`string`, but that is a Stainless codegen artifact, not permission to invent chain ids.

There is also a kit-native server signer **[source, `solana-kit.d.ts`]**:

```ts
import { PrivyClient } from '@privy-io/node';
import { createSolanaKitSigner } from '@privy-io/node/solana-kit';
import { address } from '@solana/kit';

const client = new PrivyClient({ appId: '...', appSecret: '...' });
const signer = createSolanaKitSigner(client, {
  walletId: 'wallet-id',
  address: address('...'),
});
```

It implements `MessagePartialSigner & TransactionPartialSigner & TransactionSendingSigner`.
`caip2` is documented there as "only required for sending transactions".

**Constraint that matters:** session signers at wallet-creation time are gated on the TEE
stack **[source, `CreateWalletOptions`]**:

> Session signers to associate with the wallet at creation time.
> **Only supported for TEE execution mode (`user-controlled-server-wallets-only`).**

And `sponsor: true` throws on non-TEE wallets **[source]**:
`"Sponsoring transactions is only supported for wallets on the TEE stack"`.

---

## 8. Verifying a Privy auth token in a Cloudflare Worker

Two paths. **Take the second.**

### 8.1 With the SDK

`@privy-io/node@0.34.0` README, verbatim **[source]**:

> The following runtimes are supported:
> - Node.js 20 LTS or later (non-EOL) versions.
> - Deno v1.28.0 or higher.
> - Bun 1.0 or later.
> - **Cloudflare Workers.**
> - Vercel Edge Runtime.
> - Jest 28 or greater with the `"node"` environment (`"jsdom"` is not supported at this time).
> - Nitro v2.6 or greater.
>
> > [!WARNING]
> > Web browser runtimes aren't supported. The SDK will throw an error if used in a browser environment.

```ts
import {PrivyClient} from '@privy-io/node';

const privy = new PrivyClient({
  appId: 'insert-your-app-id',
  appSecret: 'insert-your-app-secret'
});

const verifiedClaims = await privy.utils().auth().verifyAccessToken({
  access_token: accessToken
});
```

This works, but it drags the whole client (wallets, policies, key quorums, intents,
organizations, webhooks/svix, HPKE) into a Worker bundle just to check a JWT. For
HEARTROT's four cold-path routes that is not worth it.

### 8.2 Plain JWKS/JWT — recommended

Everything below was read out of `@privy-io/node@0.34.0/lib/auth.js` **[source]**:

```js
const JWT_ALGORITHM = 'ES256';
const JWT_ISSUER = 'privy.io';
// ...
const url = new URL(`${apiUrl}/v1/apps/${appId}/jwks.json`);
return createRemoteJWKSet(url, {
    cacheMaxAge: 60 * 60 * 1000,     // 60 minutes
    cooldownDuration: 10 * 60 * 1000, // 10 minutes
    headers,
});
// ...
jwtVerify(jwt, verificationKey, {
    typ: 'JWT',
    algorithms: [JWT_ALGORITHM],
    issuer: JWT_ISSUER,
    audience: appId,
});
```

and the claim mapping:

```js
return {
    app_id:     verifiedToken.payload.aud,
    issuer:     verifiedToken.payload.iss,   // 'privy.io'
    issued_at:  verifiedToken.payload.iat,
    expiration: verifiedToken.payload.exp,
    session_id: verifiedToken.payload['sid'],
    user_id:    verifiedToken.payload.sub,   // the Privy DID
};
```

`apiUrl` defaults to `https://api.privy.io` **[source, `client.js`]**, so the JWKS URL is:

```
https://api.privy.io/v1/apps/<PRIVY_APP_ID>/jwks.json
```

I confirmed by direct request that this endpoint requires **no** Authorization header
(re-probed 2026-08-31). It is a public JWKS endpoint — both failure modes are 400, never
401/403:

```
GET /v1/apps/notarealappid/jwks.json            -> 400  code: missing_or_invalid_privy_app_id
   body: {"error":"[{\"validation\":\"cuid\",\"code\":\"invalid_string\",...}]", ...}
GET /v1/apps/clzzzzzzzzzzzzzzzzzzzzzzzz/jwks.json -> 400  {"error":"Invalid Privy app id",
                                                            "code":"missing_or_invalid_privy_app_id"}
```

(the first body is a zod shape error for a non-cuid id; the second is the "app not found"
body.) The SDK sends only a `privy-client` header to it.

The whole Worker verifier:

```ts
// worker/auth.ts
import {createRemoteJWKSet, jwtVerify} from 'jose'; // jose ^6

const JWKS = createRemoteJWKSet(
  new URL(`https://api.privy.io/v1/apps/${PRIVY_APP_ID}/jwks.json`)
);

export async function privyUserId(req: Request): Promise<string> {
  const token = req.headers.get('authorization')?.replace(/^Bearer /, '');
  if (!token) throw new Error('no token');
  const {payload} = await jwtVerify(token, JWKS, {
    typ: 'JWT',                 // the SDK asserts this too; keep parity
    algorithms: ['ES256'],
    issuer: 'privy.io',
    audience: PRIVY_APP_ID,
  });
  return payload.sub as string; // did:privy:...
}
```

`jose` is WebCrypto-based and runs on Workers unmodified. `createRemoteJWKSet` caches, so
you are not fetching JWKS per request; a Worker isolate holds it for its lifetime.

**Better still for HEARTROT: skip the network entirely.** The Dashboard exposes a static
verification key at **Configuration > App settings** **[docs, access-tokens, confirmed
2026-09-01]** — the app's P-256 public key, SPKI PEM. Both `verifyAccessToken` and
`createPrivyAppJWKS` accept it as `verification_key` / `verificationKeyOverride` and then
never call `api.privy.io` at all **[source, `lib/auth.mjs`: `typeof verificationKeyOrString ===
'string' ? await importSPKI(verificationKeyOrString, 'ES256') : verificationKeyOrString`]**.
(Privy's own docs call this key "a standard Ed25519 public key" on that page — that is a docs
error; it is ECDSA P-256, which is what `ES256` and `importSPKI(pem,'ES256')` mean. Don't
copy the wrong algorithm into the Worker.) Put the
PEM in a Worker secret and use `await importSPKI(pem, 'ES256')` in place of the JWKS set —
one less cold-start fetch, one less external dependency on the request path, and Privy
rotation is a manual secret update. **Decision: do this.** Four cold-path routes do not
justify a remote key fetch.

Client side, getting the token **[docs]**:

```tsx
const { getAccessToken } = usePrivy();
const accessToken = await getAccessToken();
```

```tsx
import { getAccessToken } from '@privy-io/react-auth';
const authToken = await getAccessToken();
```

```tsx
const accessToken = await getAccessToken();
const response = await fetch('<your-api-endpoint>', {
  headers: { Authorization: `Bearer ${accessToken}` }
});
```

`getAccessToken` auto-refreshes a token that is expired or near expiry. Tokens expire
**~1 hour** after issuance. With HTTP-only-cookie mode the token also rides in a
`privy-token` cookie **[docs]**. `getAccessToken` is a real top-level export of
`@privy-io/react-auth` (aliased from `getCustomerAccessToken`) **[source]**.

There is a second token type, the **identity token** (`verifyIdentityToken`,
`useIdentityToken`, `getIdentityToken`), which carries a serialized `User` object —
useful if a Worker route needs the user's linked wallet address without an API call.
Same ES256/JWKS verification. Note the type comment **[source]**: *"the user object may
be incomplete due to the size constraints of the identity token."*

---

## 9. Pricing and limits

**[docs, privy.io/pricing]**, as of 2026-08-31:

| tier | price | MAU band |
|---|---|---|
| free | $0 | up to ~500 MAU; includes 50K signatures and $1M transaction volume monthly |
| Core | $299/mo | 500–2,499 MAU |
| Scale | $499/mo | 2,500–9,999 MAU |
| Volume PAYG | $2,000 base | above 10K MAU / 50K signatures |
| Enterprise | custom | "Signature-based pricing as low as $0.001/signature" |

Overages: **$0.05 per MAU above 10,000 MAUs**, **$0.01 per signature above 50,000
signatures**.

MAU = "any Privy-authenticated user with at least one active session in the last 30 days"
(verbatim from the FAQ).

**Hedged 2026-09-01 — the 500-MAU signup block is an inference, not a quoted rule.** The only
place the pricing page says signups stop is under the FAQ heading *"What happens to my users if I
cancel a subscription?"*: *"When you cancel your subscription, you lose feature access and support
beyond 500 MAUs. If your app has already reached 500 MAUs, new users will no longer be able to
sign up."* Privy never states this about an app that was never on a paid plan. Same wall is the
likely behaviour, but do not quote it as documented. Irrelevant to a devnet demo either way.

Privy's own definition of a billable signature, verbatim from the pricing FAQ
**[docs, re-scraped 2026-08-31]**:

> A monthly signature represents any cryptographic signature request from a Privy embedded
> wallet in the last 30 days. This includes, but is not limited to, signature endpoints such
> as: [...] `signMessage`; `signTransaction`; `signAndSendTransaction`; [...]

`signMessage` is metered. So even the "one authorization message binding the session key to
the Privy identity" idea in §10.2 is a billable signature — once per player per session, not
per tick, so it is affordable, but it is not free.

**Read this in HEARTROT terms.** A raid is 10–20 players. Even a busy devnet demo stays
under 500 MAU for a long time — free tier is fine. But the *signature* meter is the one
that would kill you if you ever routed gameplay through Privy: at a 400ms tick with 20
players, one signature per player-action would burn 50,000 signatures in well under an
hour, and then cost $0.01 each. This is a second, independent, financial reason the
session keypair must stay outside Privy.

Rate limits: Privy states REST endpoints are rate limited and to back off on HTTP 429,
but **publishes no numeric threshold** **[docs, api-reference/introduction]**. Confidence
on any specific rps number: none. Do not design against an assumed limit.

---

## 10. How this wires into HEARTROT

### 10.1 Privy's job is exactly three things

1. **Identity.** Email/Google login → a `did:privy:...` and an access token. That token is
   the only thing the four cold-path Workers routes need to authenticate
   (`session/init`, `match/start`, `match/settle`, `faucet/status`).
2. **A Solana address to attribute the run to.** `embeddedWallets.solana.createOnLogin`
   gives every email user a Solana pubkey without them knowing what a wallet is. That
   pubkey is the leaderboard identity written by the Magic Action at settlement.
3. **The one-time bridge to the session key.** Either the user's Privy wallet has SOL and
   funds the session key, or (the common case) it does not and the treasury funds it.

Privy is **not** in the gameplay path. Gameplay is: browser session keypair → sign locally
with `@solana/web3.js` or tweetnacl → POST straight to the ER. Zero Privy calls, zero
network hops beyond the ER, zero signature billing.

### 10.2 Concrete flow

```
login (Privy modal, email/google)          -> access token + embedded Solana pubkey
generate ed25519 session keypair in browser -> keep in memory / sessionStorage
POST /session/init  {sessionPubkey}         -> Worker verifies Privy JWT (jose+JWKS, §8.2)
                                            -> treasury funds sessionPubkey, pays delegation rent
POST /match/start                           -> Worker delegates Player entity to the ER
gameplay                                    -> browser signs with SESSION KEY, submits to ER directly
POST /match/settle                          -> Magic Action: ER commit + leaderboard write
```

The only place a Privy signature is even possible is if you decide the user's Privy wallet
must sign an authorization message binding the session key to their identity. If you do
that, it is exactly one `signMessage` call, and with `showWalletUIs: false` it is silent.

### 10.3 If you *do* want Privy to touch the ER

You can. Set:

```ts
solana: {
  rpcs: {
    'solana:devnet': {
      rpc: createSolanaRpc(ER_HTTP_URL),
      rpcSubscriptions: createSolanaRpcSubscriptions(ER_WS_URL),
    },
  },
}
```

and always pass `chain: 'solana:devnet'` explicitly. `signAndSendTransaction` will then
broadcast to the ER. Two caveats, both from source:

- The send path is `rpc.sendTransaction(base64, {preflightCommitment:'confirmed', encoding:'base64', skipPreflight})`
  followed by a `rpcSubscriptions.signatureNotifications(sig, {commitment:'confirmed'})`
  subscription with a **10 second timeout**. So the ER must expose a working websocket
  endpoint with signature subscriptions, or every send throws
  `"Transaction confirmation timed out"`. Pass `options.optimisticBroadcast: true` to skip
  the confirmation wait.
- Because `solana:devnet` is now aimed at the ER, you no longer have a `solana:devnet` RPC
  pointing at real devnet inside Privy. If you need both, use `signTransaction` (RPC-free)
  and do all broadcasting yourself with two plain `Connection` objects. **That is the
  recommendation** — it matches the "dual connection" pattern MagicBlock uses anyway, and
  keeps Privy out of the routing decision entirely.

### 10.4 Frontend / Next.js on Cloudflare Workers

`PrivyProvider` and every hook are client-only React. They run in the browser regardless
of where Next.js is hosted, so Cloudflare Workers deployment is not affected. Mark the
provider file `'use client'`. If you use yarn, Privy's docs give this webpack escape
hatch **[docs]**:

```ts
// next.config.ts
const nextConfig = {
  webpack: (config) => {
    config.externals['@solana/kit'] = 'commonjs @solana/kit';
    config.externals['@solana-program/memo'] = 'commonjs @solana-program/memo';
    config.externals['@solana-program/system'] = 'commonjs @solana-program/system';
    config.externals['@solana-program/token'] = 'commonjs @solana-program/token';
    return config;
  }
};
```

---

## 11. Gotchas and failure modes

1. **`chain` defaults to `solana:mainnet`.** Verified in source, in three separate places:
   `useSignTransaction`, `useSignAndSendTransaction`, and the standard-wallet injection all
   do `chain: s.chain || "solana:mainnet"`. A devnet-only game that forgets this will look
   like it works (signing succeeds, since signing ignores chain) and then fail or broadcast
   somewhere unexpected on send. **Always pass `chain: 'solana:devnet'`.**
2. **`Buffer` is required on the send path.** The bundle contains **[source]**:
   ```js
   const p = (...r) => {
     if ("undefined" == typeof Buffer) throw new PrivyError("Buffer is not defined.", undefined, BUFFER_NOT_DEFINED);
     return Buffer.from(...r);
   };
   ```
   and `sendAndConfirmTransaction` calls it. Next.js app router does not polyfill `Buffer`
   in the browser. `signTransaction` avoids this path; `signAndSendTransaction` does not.
   One more reason to prefer sign-then-broadcast-yourself.
3. **`@privy-io/server-auth` is a trap.** It still resolves on npm, most blog posts and
   older docs reference it, and its last stable publish was 2025-09-17 with betas stopping
   2025-10-03. It also depends on `@solana/web3.js@^1.95.8`. Start on `@privy-io/node`.
4. **Docs lag the package — but less than I first wrote. ~~The Solana quickstart shows
   `signTransaction({transaction})` being handed a piped kit `compileTransaction` result~~
   REFUTED 2026-08-31:** I re-read both
   `/recipes/solana/getting-started-with-privy-and-solana` and
   `/wallets/using-wallets/solana/sign-a-transaction`, and **both** end their pipe with
   `(tx) => new Uint8Array(getTransactionEncoder().encode(tx))` before passing it. The docs
   are correct on the transaction type. What *is* real: the `createWallet` snippet does
   `const wallet = await createWallet(...)` while the declared return is
   `Promise<{wallet: Wallet}>` — confirmed in `dist/dts/solana.d.ts:196` and in
   `dist/esm/solana.mjs` (`return {wallet: account}`). Destructure.
   **One more found 2026-09-01:** the `sign-a-transaction` page's signature block declares
   `transaction: SupportedSolanaTransaction`, while its own `ParamField` two screens down says
   `Uint8Array`. `SupportedSolanaTransaction` does not exist anywhere in
   `@privy-io/react-auth@3.39.0` (grepped all of `dist/dts/`); the shipped
   `SignTransactionInput.transaction` is `Uint8Array` (`dist/dts/solana.d.ts:244`). Stale docs
   type name — ignore it.
5. **Two embedded-wallet backends with different capabilities.** Session signers at
   creation, `sponsor: true`, and programmatic key export are TEE-only
   (`user-controlled-server-wallets-only`). Legacy on-device wallets silently lack them
   and throw at call time, not config time. Decide the mode in the Dashboard before writing
   any code that depends on it.
6. **On-device wallets sign a transaction by signing its message bytes as a message**, then
   splicing the signature into the tx **[source]**. Functionally correct, but it means a
   transaction whose signer address is not present in the compiled message's signer slots
   will silently produce an unsigned-in-that-slot transaction — `i in a.signatures && (a.signatures[i] = t)`
   is a conditional write with no error branch. Always make the Privy address the fee payer
   or an explicit signer.
7. **10-second confirmation timeout** on `signAndSendTransaction`, hardcoded **[source]**.
8. **Signature metering.** 50K/month free, then $0.01 each. Any design that puts a Privy
   signature on a per-frame or per-tick action is financially unbounded.
9. **No published rate-limit numbers.** Confidence: none. Assume it is low enough to matter
   for anything bursty and keep Privy off hot paths.
10. **Free tier is a hard wall at ~500 MAU**, not a soft overage — new signups are blocked.
    Fine for a devnet grant demo; a launch plan needs $299/mo budgeted.

---

## 12. Contradictions with the frozen design spec

None fatal. Three refinements:

1. **"A browser-generated session keypair signs all gameplay txs" is not just an
   optimisation, it is load-bearing.** The spec presents it as a UX choice. The evidence
   above makes it a hard requirement: Privy's fastest signing path is a cross-origin
   iframe round trip, its TEE path is an internet round trip to `api.privy.io`, and it
   bills per signature. There is no configuration of Privy that makes it viable at a 400ms
   tick. Treat this as a constraint, not a preference.
2. **"Privy embedded wallet ... OR standard wallet-connect" is simpler than it looks.**
   Privy already wraps external Solana wallets in the same Wallet Standard interface and
   returns them from the same `useWallets()`. You do not need a separate wallet-adapter
   integration; `toSolanaWalletConnectors()` plus Privy's connector list covers both. That
   removes `@solana/wallet-adapter-*` from the dependency list entirely.
3. **The spec's "browser-side airdrop" tier is unaffected by Privy.** *(Downgraded
   2026-08-31 — I originally overstated this.)* Privy's hosted devnet RPC
   (`https://solana-devnet.rpc.privy.systems?privyAppId=...`) is a shared-IP endpoint, but
   it is **not** a default: it only exists if you register `defaultSolanaRpcsPlugin()` in
   `config.plugins` (§4). Don't, and the trap cannot fire. The standing rule is unchanged
   and trivial: point the airdrop at a plain
   `Connection('https://api.devnet.solana.com')` from the browser.

One thing the spec does not mention that it should: **which embedded wallet mode**
(`legacy-embedded-wallets-only` vs `user-controlled-server-wallets-only`). It changes
whether session signers, sponsorship and programmatic export are available. **Corrected
2026-09-01:** take the TEE default and write nothing in the spec beyond "default". A new app is
already `user-controlled-server-wallets-only`; on-device requires asking Privy to enable it and
would buy HEARTROT nothing, because §12.5 puts zero Privy signatures on any path.

---

## 12.5 Decisions forced (2026-08-31)

The items below were left open. They are decidable on the evidence already gathered, and
leaving them open would block the build, so they are decided here.

| question | decision | why |
|---|---|---|
| Embedded wallet mode | **`user-controlled-server-wallets-only` (TEE) — i.e. change nothing.** *(REVERSED 2026-09-01.)* | TEE is what a new Privy app already is; on-device is the gated "advanced configuration" you must email Privy for (§6, corrected). The old rationale for legacy — "avoids an internet RTT on the one signature you might take" — is void because the row below decides there is **no** Privy signature at all. So legacy buys nothing and costs a support thread on a grant deadline. It is also not the safe default it was claimed to be: on-device → TEE is explicitly **one-way**, and on-device carries the §6.3a proxy-boot + recovery-throws-headlessly cliff. |
| Register `defaultSolanaRpcsPlugin()`? | **No** | With no plugin and no `solana.rpcs`, Privy holds no RPC at all. That is the desired state: it cannot route anything, and the shared-IP airdrop trap cannot fire. |
| Point Privy's `solana:devnet` at the ER? | **No** | Use `signTransaction` (RPC-free, verified) and broadcast yourself with two plain `Connection`s. Aiming `solana:devnet` at the ER burns your only devnet slot, and `signAndSendTransaction` hard-requires ER websocket `signatureNotifications` within 10 s plus a `Buffer` polyfill. |
| Privy access-token verification in the Worker | **Static `verification_key` (SPKI PEM) from the Dashboard, `jose` `importSPKI` + `jwtVerify`.** No JWKS fetch, no Privy SDK. | §8.2. Four cold routes do not justify a remote key fetch or a 5 MB SDK. |
| Does the Privy wallet sign an authorization message binding the session key? | **No.** | The Worker already proves identity from the JWT, and the treasury (not the user) funds the session key. A `signMessage` here buys nothing, costs a metered signature, and drags in the §6.3a proxy-boot/recovery path. Drop it; if a later audit wants the binding, it is one call to add. |
| Do we need `@privy-io/react-auth/solana` at all? | **Yes, but only for `useWallets` + `toSolanaWalletConnectors`** (external-wallet path and the embedded pubkey). No signing hooks are imported. |
| `@solana/wallet-adapter-*` | **Drop.** | Privy returns external wallets through the same Wallet Standard `ConnectedStandardSolanaWallet[]`, verified in `dist/dts/solana.d.ts:157`. |

Still genuinely open (do not decide without measurement): §13.

---

## 13. Open questions I could not close

- **Exact numeric rate limits** on `api.privy.io`. Privy documents 429 + backoff and no
  numbers. Confidence: none.
- **Whether Privy's backend would accept a MagicBlock ER CAIP-2** in server-side
  `signAndSendTransaction`. The type is `Caip2 = string`, but that is Stainless codegen
  laxity. I found no evidence Privy can route to a non-standard chain id. Untested.
  Server-side `signTransaction` (no caip2) sidesteps this entirely.
- **Measured signing latency** for each backend. I read the code paths but ran no
  benchmark. Worth a 20-line timing script before committing to any Privy signature on a
  user-visible path. *(2026-09-01: Privy does publish one number —* "On-device execution
  enables the **fastest-possible signing speed (5 ms)**" *[docs,
  `/security/wallet-infrastructure/advanced/user-device`]. Read it as the in-iframe key-reassembly
  + sign cost only: it excludes the postMessage round trip and the §6.3a proxy boot, and it is a
  vendor claim for the path HEARTROT is **not** on. No published figure exists for TEE. Still
  unmeasured; still nowhere near a 400 ms tick budget shared with an ER round trip.)*
- **Whether the MagicBlock router RPC** (referenced in MagicBlock marketing as a
  "single-point RPC" that routes between base layer and ER) is a drop-in URL for Privy's
  `solana:devnet` rpc config. I did not verify the router's endpoint or its websocket
  support. Cross-check against the MagicBlock research topic.

---

## Sources

Fetched and read on 2026-08-31.

- https://docs.privy.io/recipes/solana/getting-started-with-privy-and-solana
- https://docs.privy.io/recipes/react/manage-wallet-UIs
- https://docs.privy.io/guide/react/wallets/embedded/solana/creation
- https://docs.privy.io/wallets/using-wallets/solana/sign-a-transaction
- https://docs.privy.io/wallets/using-wallets/solana/send-a-transaction
- https://docs.privy.io/wallets/using-wallets/signers/quickstart
- https://docs.privy.io/wallets/using-wallets/signers/configure-signers
- https://docs.privy.io/recipes/wallets/user-and-server-signers
- https://docs.privy.io/authentication/user-authentication/access-tokens
- https://docs.privy.io/api-reference/introduction
- https://docs.privy.io/basics/nodeJS/setup
- https://docs.privy.io/reference/sdk/react-auth/changelog
- https://www.privy.io/pricing
- https://api.privy.io/v1/apps/{appId}/jwks.json (probed directly; public, no auth)
- npm registry metadata for `@privy-io/react-auth`, `@privy-io/node`, `@privy-io/server-auth`,
  `@privy-io/js-sdk-core`, `@privy-io/expo`, `@privy-io/cross-app-connect`, `@privy-io/public-api`,
  `@solana/kit`, `@solana/web3.js`, `@solana-program/system`
- Package tarballs read directly (via `npm pack`, then the shipped `.d.ts` and `dist/esm/*.mjs`):
  - `@privy-io/node@0.34.0` — `README.md`, `lib/auth.d.ts`, `lib/auth.js`, `client.js`,
    `solana-kit.d.ts`, `public-api/PrivyClient.js`, `public-api/services/solana.d.ts`,
    `resources/wallets/wallets.d.ts`, `resources/apps/apps.d.ts`
  - `@privy-io/react-auth@3.39.0` — `README.md`, `dist/dts/solana.d.ts`, `dist/dts/index.d.ts`,
    `dist/dts/types-C8c3jEOh.d.ts`, `dist/esm/solana.mjs`, `dist/esm/useWallets-DNK5FqjA.mjs`,
    `dist/esm/useSolanaRpcClient-hNOxPuXt.mjs`, `dist/esm/index-BMVqHT_T.mjs`

---

## Verification

Adversarial re-check, 2026-08-31, by a second agent. Method: I did not trust the source list
above. I re-pulled both tarballs myself (`npm pack @privy-io/react-auth@3.39.0
@privy-io/node@0.34.0`), grepped the shipped `.d.ts` and `dist/esm/*.mjs`, re-scraped
`privy.io/pricing` as raw HTML rather than through a summariser, probed
`api.privy.io/v1/apps/*/jwks.json` directly, and **ran** the kit/web3.js interop rather than
reasoning about it.

### Confirmed against the shipped package (not docs)

- `@privy-io/react-auth` `latest` = **3.39.0**; `@privy-io/node` `latest` = **0.34.0**;
  `@privy-io/server-auth` `latest` = **1.32.5, published 2025-09-17**, last beta
  **2025-10-03** — the "abandoned" call stands.
- Peer deps of react-auth match the doc **verbatim**. Hard deps confirmed: `viem`,
  `styled-components`, `@base-ui/react`, `@headlessui/react`, `@coinbase/wallet-sdk`,
  `@walletconnect/*`, `x402`. No `@solana/web3.js`.
- `@privy-io/node` deps match verbatim. Stronger than the README claim: I grepped every
  `.js`/`.mjs` in the package for `node:` builtins and found **two hits, both inside an error
  message string** (`internal/uploads`). Zero real Node-builtin imports. It is genuinely
  Workers-safe, not just documented as such.
- `dist/dts/solana.d.ts`: `SignTransactionInput.transaction: Uint8Array`, output
  `{signedTransaction: Uint8Array}`; `SignAndSendTransactionInput` adds
  `sponsor`/`optimisticBroadcast`/`skipSimulation`. Hook export list matches exactly.
  `useWallets(): {ready, wallets: ConnectedStandardSolanaWallet[]}` — the one-code-path
  claim for Phantom + embedded holds.
- `SolanaChain = ["solana:mainnet","solana:devnet","solana:testnet"]`, and
  `ae="solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"`, `re="solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"`
  — byte-for-byte as quoted.
- Headless decision function, verbatim from `index-BMVqHT_T.mjs`:
  `Oe=({showWalletUIs:e})=>Ue.current?Ue.current:void 0!==e?!e:!s.embeddedWallets.showWalletUIs`
  — the deminified version in §6.2 is accurate.
- `signTransaction` body dumped in full. **`chain` is used only in the modal-path payload**;
  no RPC client is constructed anywhere in it. The load-bearing claim of this whole document
  is correct.
- `timeout: 1e4` (10 s) hardcoded in the confirm helper; `preflightCommitment:'confirmed',
  encoding:'base64'` hardcoded in the send; the `Buffer` guard throwing
  `BUFFER_NOT_DEFINED` sits directly on that send path. All three confirmed.
- The splice `de(e,n,t)` is exactly `i in a.signatures && (a.signatures[i]=t)` — conditional
  write, no error branch. Confirmed, and reproduced (below).
- TEE gating strings confirmed: `"Sponsoring transactions is only supported for wallets on
  the TEE stack"`, and `Only supported for TEE execution mode
  (user-controlled-server-wallets-only)` on session signers at creation.
- `@privy-io/node/solana-kit` subpath and `createSolanaKitSigner` exist; `caip2?: string`
  documented "only required for sending". Server `SolanaSignTransactionRpcInput` has **no**
  `caip2`; `SolanaSignAndSendTransactionRpcInput` requires it. Asymmetry confirmed.
- `lib/auth.mjs` matches the quoted constants line for line: `ES256`, issuer `privy.io`,
  audience `appId`, `typ:'JWT'`, JWKS at `${apiUrl}/v1/apps/${appId}/jwks.json`,
  `cacheMaxAge` 60 min / `cooldownDuration` 10 min, claims `sub`/`sid`/`aud`/`iat`/`exp`.
- `getCustomerAccessToken as getAccessToken` is a real top-level export of
  `@privy-io/react-auth`.
- Pricing: I scraped the raw page rather than trusting a summariser (a summariser misread the
  tier names on first pass). Raw text gives **Free 0–499 / Core $299 500–2,499 / Scale $499
  2,500–9,999**, PAYG base **$2,000**, **$0.05/MAU above 10,000**, **$0.01/signature above
  50,000**, Enterprise "as low as $0.001/signature", and the cancel/500-MAU signup block.
  The doc's table was already right.
- All 13 documented source URLs return HTTP 200. None were invented.
- JWKS endpoint is public: 400 (not 401/403) with no auth header, on two different bad app
  ids.

### Run, not read

Installed `@solana/kit@8.2.0` and `@solana/web3.js@1.98.4` and executed Privy's exact
decode→splice→encode sequence. A v0 `VersionedTransaction` (217 B) and a **legacy**
`Transaction` (215 B, the shape `anchor .transaction()` returns) both decode, both round-trip
**byte-identical**, the payer appears in `.signatures`, a spliced signature reads back
correctly through `VersionedTransaction.deserialize()`, and a non-signer address returns
`false` from the `in` check — the silent no-op is real. The "no kit migration needed for BOLT
tooling" conclusion is now empirical rather than inferred.

### Corrected in place

1. **§4 — hosted-RPC fallback is opt-in, not automatic.** The doc said "if you omit
   `solana.rpcs`, Privy falls back to its own hosted RPCs". It does not.
   `defaultSolanaRpcsPlugin` is a plugin the app must register via `config.plugins`
   (`PrivyClientConfig.plugins?: Array<... | DefaultSolanaRpcsPlugin>`, and `PrivyProvider`
   passes `configPlugins: config.plugins`). With neither, `useSolanaRpcClient` throws.
   This also **downgrades §12.3** from a live hazard to a non-issue you simply don't opt into.
2. **§11.4 — half the "docs lag the package" claim is refuted.** Both doc pages *do* encode
   to `Uint8Array` via `getTransactionEncoder()` before calling `signTransaction`. Only the
   `createWallet` destructuring mismatch is real. Struck through and corrected rather than
   deleted, so the claim isn't silently re-derived later.
3. **§6.3a added — headless signing has preconditions the doc omitted.** The legacy path runs
   `initializeWalletProxy(15_000)` and `recoverEmbeddedWallet()` before it signs. So the
   first headless signature has a 15 s ceiling, and if the app uses user-controlled recovery,
   headless signing **throws with no modal fallback** rather than prompting. "Zero popups is
   one config line" was too clean.
4. **§6.1 — added the real default.** `showWalletUIs ?? enforce_wallet_uis ?? true`: the
   final fallback is *show the modal*. Also noted `mode` is read off the server config, so
   legacy-vs-TEE is Dashboard-only with no client override.
5. **§2 — all Solana peers are `optional: true`** in `peerDependenciesMeta`. The doc listed
   them as if mandatory.
6. **§5 — added the empirical round-trip table** and the `Transaction.serialize()` gotcha
   (throws on an unsigned legacy tx without `{requireAllSignatures:false,
   verifySignatures:false}`; `VersionedTransaction.serialize()` does not).
7. **§8.2 — added `typ:'JWT'`** to the Worker snippet for parity with the SDK, and added the
   **static `verification_key` / `importSPKI` path** that removes the JWKS fetch entirely.
8. **§8.2 — corrected the quoted 400 body.** A non-cuid app id returns a zod validation body;
   `{"error":"Invalid Privy app id"}` is the body for a cuid-shaped but nonexistent id. Both
   400, same error code. The public-endpoint conclusion is unchanged.
9. **§9 — added Privy's own definition of a billable signature**, which explicitly names
   `signMessage`. Relevant to the §10.2 authorization-message idea.
10. **§12.5 added — forced the hedges into decisions**: legacy wallet mode; do not register
    the RPC plugin; do not point Privy at the ER; static verification key in the Worker; no
    session-key authorization message; keep `/solana` for `useWallets` +
    `toSolanaWalletConnectors` only; drop `@solana/wallet-adapter-*`.

### Still unverified

- **Measured latency** of either signing backend. Still unbenchmarked. §6.3a makes the
  cold-path picture worse (15 s ceiling on proxy boot), not better, so the conclusion holds
  a fortiori — but no number was taken.
- **`api.privy.io` rate limits.** Still unpublished. Unchanged.
- **Whether Privy's backend routes a MagicBlock ER CAIP-2** in server-side
  `signAndSendTransaction`. Untested, and §12.5 makes it moot for HEARTROT.
- **Whether the MagicBlock router RPC works as a `solana:devnet` URL**, and whether the ER
  exposes websocket `signatureNotifications`. Not tested here — cross-check against the
  MagicBlock topic. §12.5 routes around it.
- **`recoverEmbeddedWallet` behaviour under each recovery method.** I traced the call and its
  throw, but did not run a real Privy app with user-controlled recovery to confirm it cannot
  complete headlessly. §6.3a is a code-path inference, not an observation. Verify before
  enabling any non-Privy-managed recovery.
- Nothing in this document was tested against a live Privy app id. Every dynamic claim is
  from the shipped bundle, the public pricing page, or the unauthenticated JWKS endpoint.

---

## Verification pass 2 (adversarial, 2026-09-01)

Third agent. I trusted neither the original research nor the first Verification section. Method:
re-resolved every version off `registry.npmjs.org`, re-downloaded both tarballs from the registry
`dist.tarball` URLs (not from a local cache), re-grepped the shipped `.d.ts` and `dist/esm/*.mjs`
for every quoted string, re-scraped `privy.io/pricing` as raw HTML, re-probed the JWKS endpoint,
HEAD-checked all 13 cited URLs, and pulled the Privy docs as raw `.md` via Mintlify's `.md`
suffix so no summariser sat between me and the text.

### One decision reversed

**The embedded-wallet-mode decision in §12.5 was backwards, and the reasoning under it was wrong
in two independent ways.** Corrected in place (§6 mode note, §6.3a scope note, §12.5 row, §12
closing paragraph):

- The doc chose `legacy-embedded-wallets-only` as the cheap default. It is not the default.
  `/security/wallet-infrastructure/advanced/user-device` states *"By default, Privy uses trusted
  execution environments (TEEs) [...] On-device execution is an advanced configuration. Please
  reach out to enable this setting [...] Otherwise, your app uses TEE execution."* The shipped
  bundle agrees: the placeholder `serverConfig` in `context-97je72pd.mjs` carries
  `mode:"user-controlled-server-wallets-only"`. Legacy costs a Privy support request.
- The doc called the choice reversible via `useMigrateWallets`. It is not.
  `/recipes/tee-wallet-migration-guide`: *"This is a one-way change, and on-device execution is
  disabled once migration occurs."* The hook migrates on-device → TEE only.
- The stated benefit ("legacy avoids an internet RTT on the one signature you might take")
  was already void inside the same table, whose next-but-one row decides HEARTROT takes **no**
  Privy signature at all.

Net effect on the build: **none, and that is the point** — the corrected decision is "change
nothing in the Dashboard", which removes a support-ticket dependency from a grant-deadline path.

### Re-confirmed first-hand (independent of both prior agents)

Versions, off the registry on 2026-09-01: `@privy-io/react-auth` latest **3.39.0**;
`@privy-io/node` latest **0.34.0** published 2026-08-28T17:49Z; `@privy-io/server-auth` latest
**1.32.5** published **2025-09-17**, last beta `1.32.6-beta-20251003214300` — the "abandoned"
call stands; `@privy-io/js-sdk-core` 0.72.1 (2026-08-31); `@solana/kit` 8.2.0 (2026-08-29);
`@solana/web3.js` 1.98.4; `@solana-program/system` 0.14.0.

From the tarballs:

- Peer deps match §2 verbatim. `peerDependenciesMeta` marks **every** Solana peer plus
  `permissionless`, `@abstract-foundation/agw-client`, `@farcaster/mini-app-solana` as
  `optional: true`; `react`/`react-dom` are the only non-optional peers. Hard deps confirmed
  (`viem@2.56.0`, `styled-components`, `@base-ui/react`, `@headlessui/react`,
  `@coinbase/wallet-sdk@4.3.2`, `@walletconnect/*@2.22.4`, `x402`, plus `@stripe/crypto`,
  `@hcaptcha/react-hcaptcha`, `lucide-react`, `qrcode`, `pino-pretty`). No `@solana/web3.js`.
- `dist/dts/solana.d.ts:244` — `SignTransactionInput.transaction: Uint8Array`. Output
  `{signedTransaction: Uint8Array}`. The "no kit migration for BOLT tooling" conclusion holds.
- `signTransaction` body dumped in full from `useWallets-DNK5FqjA.mjs`. **No RPC client is
  constructed anywhere in it**; `chain` appears only in the modal payload object. This is the
  document's load-bearing claim and it is correct.
- Headless branch verbatim: `Oe=({showWalletUIs:e})=>Ue.current?Ue.current:void 0!==e?!e:!s.embeddedWallets.showWalletUIs`.
- Normaliser verbatim: `showWalletUIs:t?.embeddedWallets?.showWalletUIs??e.enforce_wallet_uis??!0`
  — final fallback really is *show the modal*.
- `chain="solana:mainnet"` default: two default-parameter sites in `useWallets-DNK5FqjA.mjs`
  plus `chain:s.chain||"solana:mainnet"` twice in `solana.mjs` (both hooks) and in
  `use-export-wallet` / `use-unlink-wallet`. Gotcha 1 confirmed, and it is more places than the
  doc claimed.
- §6.3a preconditions verbatim: `getAccessToken()` → `await t(15e3)` proxy init → `if(!await
  i({address}))throw Error("Unable to connect to wallet")`. Real, and legacy-path-only.
- Splice verbatim: `function de(e,n,t){let a=structuredClone(_().decode(e)),i=E(n);return i in
  a.signatures&&(a.signatures[i]=t),new Uint8Array(I().encode(a))}` — conditional write, no else.
- `useSolanaRpcClient-hNOxPuXt.mjs` read end to end: the Buffer guard throwing
  `BUFFER_NOT_DEFINED`, `preflightCommitment:"confirmed", encoding:"base64"`,
  `signatureNotifications(sig,{commitment:"confirmed"})`, and `timeout:1e4` are all on the
  send path exactly as described. Also confirmed `skipConfirmation: options.optimisticBroadcast`
  and `skipPreflight: options.skipSimulation` — §10.3's escape hatch is real.
- Hosted-RPC plugin is opt-in: `configPlugins: t?.plugins` in `index-BMVqHT_T.mjs`,
  `solanaRpcs` in `context-97je72pd.mjs` built purely from `config.solana.rpcs` with `?? null`,
  and the merge `r.solanaRpcs[n] ?? o?.[n] ?? null` where `o` is the plugin lookup. First
  agent's correction #1 stands; I extended it with the wss URLs and the merge order.
- `toSolanaWalletConnectors` and `defaultSolanaRpcsPlugin` **are** exported from
  `@privy-io/react-auth/solana` (via `dist/dts/solana.d.ts:2` re-export from
  `types-C8c3jEOh`), even though they are absent from the hook list quoted in §3. §12.5's
  "keep `/solana` for `useWallets` + `toSolanaWalletConnectors`" is safe.
- `@privy-io/node`: README lists Cloudflare Workers verbatim. I re-ran the builtin grep — the
  only `node:` occurrences in the whole package are **two hits of the same error-message string**
  in `internal/uploads.{js,mjs}` (`"...set globalThis.File to import('node:buffer').File"`).
  Zero real Node-builtin imports, zero bare `require('crypto'|'fs'|...)`. Workers-safe.
- `lib/auth.mjs` read in full: `ES256`, issuer `privy.io`, `typ:'JWT'`, `audience: appId`, JWKS
  at `${apiUrl}/v1/apps/${appId}/jwks.json` with 60 min / 10 min cache, claim map
  `aud/iss/iat/exp/sid/sub`, and the `importSPKI(verification_key,'ES256')` branch that skips the
  network. The Worker recipe in §8.2 is correct as written.
- `caip2` asymmetry confirmed at `resources/wallets/wallets.d.ts:1713` (required on
  `SolanaSignAndSendTransactionRpcInput`) vs `:1805` (absent from `SolanaSignTransactionRpcInput`).
  `./solana-kit` subpath and its `.d.ts`/`.mjs` exist.
- `EmbeddedWalletCreateOnLoginConfig = 'users-without-wallets' | 'all-users' | 'off'`.
- JWKS endpoint re-probed with no auth header: `notarealappid` → **400** with a zod `Invalid cuid`
  body; `clzzzzzzzzzzzzzzzzzzzzzzzz` → **400** `{"error":"Invalid Privy app id"}`; a third
  cuid-shaped id → 400. Never 401/403. Public, as claimed.
- Pricing re-scraped raw: `Free 0-499 / Core 500–2,499 $299 / Scale 2,500-9,999 $499`,
  `PAYG base $2,000`, `$0.05 per MAU above 10,000`, `$0.01 per signature above 50,000`,
  Enterprise "as low as $0.001/signature". The billable-signature list does include
  `signMessage; signTransaction; signAndSendTransaction`, prefixed *"includes, but is not
  limited to"*. §9's table is right.
- All 13 cited URLs return HTTP 200, and I read the two load-bearing ones as raw markdown:
  `manage-wallet-UIs` confirms the three-level `showWalletUIs` precedence and the Dashboard path
  *Configuration > Authentication > Advanced > "Disable confirmation modals"*; `sign-a-transaction`
  does end its pipe with `new Uint8Array(getTransactionEncoder().encode(tx))`, so the first
  agent's refutation of the "docs pass a kit object" claim stands.

### Also corrected in place this pass

1. **§12.5 / §12 / §6 — embedded wallet mode reversed to TEE** (above). The single substantive
   error found in two verification passes.
2. **§6.3a scoped** to the legacy path, so nobody reads a 15 s cold-start ceiling into HEARTROT's
   actual configuration.
3. **§9 — the 500-MAU signup wall de-quoted.** Privy states it under *"What happens if I cancel a
   subscription?"*, never about a never-paid free app. Same wall is likely; it is not documented.
4. **§8.2 — named the exact Dashboard location** of the static verification key (*Configuration >
   App settings*) since a decision now depends on finding it, and flagged that Privy's own
   access-tokens page miscalls that key "Ed25519" when it is P-256/`ES256`.
5. **§11.4 — one residual docs-lag item added:** `sign-a-transaction` declares
   `transaction: SupportedSolanaTransaction`, a type that exists nowhere in the shipped package.
6. **§4 — hosted-RPC plugin quote completed** with its `wss://` subscriptions and the exact
   config-wins-over-plugin merge order.

### Refuted claims from the researcher's summary

- *"`@privy-io/react-auth@3.39.0` peer-depends on `@solana/kit >=3.0.3`"* — true but misleading as
  stated: it is an **optional** peer, as are all four Solana peers. Installing react-auth alone
  pulls in no Solana stack. The summary's "you will ship two Solana stacks" risk only fires if you
  import the `/solana` subpath, which HEARTROT does.
- *"Privy's default hosted RPCs when `solana.rpcs` is omitted"* — refuted (first pass, re-confirmed
  here). There is no default; you get a throw. This also demotes the summary's airdrop
  contradiction from a hazard to a non-issue.
- *"Docs lag in at least two places — the quickstart passes a piped kit `compileTransaction`"* —
  refuted. Both pages encode to `Uint8Array` first. A different docs-lag item is real (item 5).

### Still unverified after two passes

- No test against a live Privy app id. Nothing dynamic was exercised: no login, no wallet
  creation, no real access token verified, no signature taken.
- No measured latency for either backend. Privy's published 5 ms is for on-device only and is
  a vendor figure for a path this design does not use.
- `api.privy.io` rate limits: still unpublished.
- Whether Privy's backend routes a MagicBlock ER CAIP-2 in server-side `signAndSendTransaction`.
  §12.5 routes around it; still untested.
- Whether the MagicBlock router RPC works as a `solana:devnet` URL and exposes websocket
  `signatureNotifications`. Belongs to the MagicBlock topic, not this one.
- Whether a **TEE** app can be moved back to on-device. Docs say the on-device → TEE direction is
  one-way; they do not describe the reverse at all, so treat "accept the TEE default" as
  effectively permanent for the app id you ship on.
