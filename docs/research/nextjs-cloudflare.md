# Next.js on Cloudflare Workers: vinext vs OpenNext

Research date: **2026-08-31**. Everything below was verified against primary sources on that
date (repo source, npm registry, `wrangler` JSON schema, Cloudflare docs source in
`cloudflare/cloudflare-docs`). URLs at the bottom.

---

## 0. TL;DR for HEARTROT

**Cloudflare's official recommendation has changed and the search result is accurate**:
vinext is now the default path for Next.js on Workers, OpenNext is documented as the
fallback for existing apps that can't migrate. Verbatim from
`src/content/docs/workers/framework-guides/web-apps/nextjs.mdx`:

> Cloudflare recommends [vinext](https://vinext.dev/) as the default way to run Next.js
> applications on Cloudflare Workers.

and the "other paths" table:

| Path | Use when |
| --- | --- |
| OpenNext adapter | You maintain an existing OpenNext application that cannot yet migrate to vinext because of a compatibility gap. |
| Static Next.js on Pages | Your application is a static export and you specifically want to deploy it to Cloudflare Pages. |

**But for our app specifically the honest answer is: we probably shouldn't be on Next.js at all.**

HEARTROT's frontend is a client-rendered SVG canvas + 4 cold-path route handlers, with all
gameplay traffic going browser → ER directly. We use approximately none of the Next.js API
surface that vinext or OpenNext exists to reproduce: no RSC data fetching, no ISR, no
`next/image` optimization, no server actions, no middleware.

The decision-relevant fact, verbatim from the vinext README (`README.md:751`):

> Next.js statically pre-renders pages at build time (making builds slower but production
> serving faster for static content), while **vinext server-renders all pages on each request**.

Under vinext, *every page load of our game shell is a billed Worker invocation*. Under
OpenNext, the HTML document also goes through the Worker (prerendered HTML is served out of
the incremental cache, not out of Workers Static Assets — only `_next/static` and `public/`
bypass the Worker). Meanwhile Cloudflare docs state, verbatim:

> Requests to static assets are free and unlimited. Requests to the Worker script (for
> example, in the case of SSR content) are billed according to Workers pricing.

So the ranking for HEARTROT:

1. **Best fit — Vite + React SPA + one plain Worker** (`assets.not_found_handling:
   "single-page-application"`, `run_worker_first: ["/api/*"]`). HTML, JS, and the SVG sprite
   rig are static assets → free, no invocation, no cold start. The Worker runs only for our
   4 cold-path routes. No beta framework in the critical path. ~30 lines of wrangler config.
   Section 8 has the config.
2. **If Next.js is non-negotiable — vinext**, not OpenNext. It is Cloudflare's recommended
   path, it is a fresh project (so the "existing app can't migrate" OpenNext carve-out does
   not apply to us), the 4 route handlers are in vinext's fully-supported core, and our
   near-zero use of Next.js features means the beta compatibility gaps almost all miss us.
   Accept: a Worker invocation per page load, and `1.0.0-beta.8` in production.
3. **OpenNext** only if we discover a specific vinext gap. It is *not* abandoned — 1.20.5
   shipped 2026-08-31, the same day as this research.

Confidence: **high** on the facts, **medium** on option 1 being accepted, since the frozen
design spec says "Frontend: Next.js deployed on Cloudflare Workers" (see §10, Contradictions).

---

## 1. What vinext actually is

vinext is **not** an adapter. OpenNext consumes the output of `next build` and re-hosts it.
vinext throws that away and reimplements the Next.js public API on top of Vite. Verbatim
from the README:

> vinext reimplements the Next.js API surface on Vite rather than consuming `next build`
> output. It supports both the App Router and Pages Router, React Server Components, Server
> Actions, middleware, route handlers, ISR, static export, and the most commonly used
> `next/*` modules. Cloudflare Workers has the deepest integration; Node.js and other
> platforms are available with different levels of support.

Consequences worth internalizing:

- **`next` is not a dependency.** README: *"vinext ships fallback declarations for the
  supported `next` and `next/*` APIs, so applications can run and type-check without the
  `next` package."*
- **It targets Next.js 16.x only.** README design principle: *"Latest Next.js only. Targets
  Next.js 16.x. No support for deprecated APIs from older versions."*
- **It is written largely by AI, reviewed by humans.** README FAQ, verbatim: *"A mix of
  humans and AI agents. Humans review PRs before they merge... We lean heavily on
  agent-driven code review... The test suite is the primary quality gate."* The Cloudflare
  blog post is literally titled *"How we rebuilt Next.js with AI in one week."* This is not
  a reason to reject it, but it is a reason to weight the test-suite numbers and the open
  issue list over the marketing numbers.
- **Provenance check:** the canonical site is **vinext.dev** (linked from the README as
  "Website"). There is also a **vinext.io** which describes itself as "community-maintained…
  independent, not officially affiliated with Cloudflare." Do not cite vinext.io as
  official. Similarly, `mintlify.wiki/cloudflare/vinext/...` mirrors document a
  `getEnv()` helper from `vinext/cloudflare` — **that API does not exist** (re-verified
  2026-08-31 against the published tarballs; see G7 for the full teardown — the specifier, the
  export map, and the symbol are all wrong). The real API is
  `import { env } from "cloudflare:workers"`. Flagging
  this because it is exactly the kind of confidently-wrong API that costs a week.

---

## 2. Exact pinned versions (npm registry, 2026-08-31)

| Package | Latest | Published | Notes |
| --- | --- | --- | --- |
| `vinext` | **1.0.0-beta.8** | 2026-08-20 | 76 versions published; beta cadence ~weekly |
| `@vinext/cloudflare` | **1.0.0-beta.6** | 2026-08-15 | the deploy CLI + cache adapters |
| `create-vinext-app` | **1.0.0-beta.2** | 2026-08-07 | |
| `@vinext/types` | **1.0.0-beta.2** | — | |
| `@opennextjs/cloudflare` | **1.20.5** | 2026-08-31 | actively maintained, released today |
| `next` | **16.3.3** | 2026-08-25 | canary 16.4.0-canary.12 |
| `vite` | **8.2.2** | 2026-08-20 | vinext peer-requires `^8.0.0` |
| `wrangler` | **4.127.1** | 2026-08-28 | |
| `@cloudflare/vite-plugin` | **1.54.2** | 2026-08-28 | |
| `@vitejs/plugin-rsc` | **0.5.34** | 2026-08-07 | optional peer of vinext, App Router only |

`vinext@1.0.0-beta.8` declared metadata, verbatim:

```json
"engines": { "node": ">=22" },
"peerDependencies": {
  "vite": "^8.0.0",
  "react": "^19.2.6",
  "react-dom": "^19.2.6",
  "@mdx-js/rollup": "^3.0.0",
  "@vitejs/plugin-rsc": "^0.5.34",
  "@vitejs/plugin-react": "^5.1.4 || ^6.0.0",
  "react-server-dom-webpack": "^19.2.6"
}
```

`@opennextjs/cloudflare@1.20.5` peers, verbatim:

```json
"peerDependencies": {
  "next": ">=15.5.24 <16 || >=16.3.3",
  "wrangler": "^4.125.0",
  "rclone.js": "^0.6.6"
}
```

Note vinext requires **Node >= 22** locally and **Vite 8**. If the repo pins Node 20 in CI,
that has to move.

### Production readiness, stated by the maintainers

vinext README, verbatim (FAQ "Can I use this in production?"):

> You can, with caution. vinext has known compatibility gaps and has not yet been
> battle-tested across the full range of production Next.js workloads. Evaluate the features
> and deployment target your application relies on before adopting it.

Cloudflare docs, verbatim:

> vinext is in beta. Before adopting it for an existing production application, run the
> compatibility check from your project directory and review the vinext compatibility
> dashboard.

The compatibility dashboard (vinext.dev/compatibility) as of the 2026-08-31 02:19 UTC run,
against Next.js v16.2.6 on vinext `main`, across 799 test files:

- Supported pass rate **99.6%**
- Overall pass rate **95.9%**
- Supported surface coverage **93.9%**
- App Router 99.7% supported / 94.6% overall; Pages Router 99.7% / 97.8%

Read that carefully: "supported pass rate" is the pass rate *of the things vinext claims to
support*. "Overall" includes the deliberate gaps. Neither number tells you about your app.

---

## 3. What vinext supports, and what it does not

Verbatim from the README ("Known gaps we're working on" — these are *not* permanent
exclusions):

> - **Cache Components and Partial Prerendering:** `"use cache"` is partially implemented,
>   but full `cacheComponents` behavior is still incomplete. Cache profiles, tags, partial
>   shells, resume behavior, prefetching, and some dev/build cache semantics do not yet match
>   Next.js in every case.
> - **Build-time image and font optimization:** images can be optimized at request time on
>   Cloudflare, but vinext does not yet reproduce Next.js's complete build-time image
>   pipeline. Google Fonts are loaded from the CDN, and local font CSS is injected at runtime
>   rather than extracted during the build.
> - **Native modules in App Router development:** packages such as `sharp`, `resvg`,
>   `satori`, `lightningcss`, and `@napi-rs/canvas` can fail in Vite's RSC development
>   environment. Production builds support more of these cases than development mode.
> - **Platform-specific and advanced Next.js behavior:** `runtime` and `preferredRegion`
>   route config are currently ignored, and some recently introduced or undocumented Next.js
>   behavior may not yet be reproduced.

Verbatim from "What's NOT supported (and won't be)" — permanent:

> - **Vercel-specific features** — `@vercel/og` edge runtime, Vercel Analytics integration,
>   Vercel KV/Blob/Postgres bindings. Use platform equivalents.
> - **AMP** — Deprecated since Next.js 13. `useAmp()` returns `false`.
> - **`next export` (legacy)** — Use `output: 'export'` in config instead.
> - **Turbopack/webpack configuration** — This runs on Vite. Use Vite plugins instead of
>   webpack loaders/plugins.
> - **`next/jest`** — Use Vitest.
> - **`create-next-app` scaffolding** — Use `create-vinext-app` for new vinext projects.
> - **Bug-for-bug parity with undocumented behavior** — If it's not in the Next.js docs, we
>   probably don't replicate it.

### Feature-by-feature, filtered to what HEARTROT touches

| Feature we use | vinext | Source (README API coverage table, verbatim notes) |
| --- | --- | --- |
| Route handlers (`route.ts`) | ✅ | "Named HTTP methods, auto OPTIONS/HEAD, cookie attachment" |
| App Router file routing | ✅ | "Pages, routes, layouts, templates, loading, error, not-found, forbidden, unauthorized" |
| `next/navigation` | ✅ | `usePathname`, `useSearchParams`, `useParams`, `useRouter`, `redirect`, `notFound` |
| `next/server` (`NextRequest`/`NextResponse`) | ✅ | "`NextRequest`, `NextResponse`, `NextURL`, cookies, `userAgent`, `after`, `connection`, `URLPattern`" |
| `next/headers` | ✅ | "Async `headers()`, `cookies()`, `draftMode()`" |
| Client components / `"use client"` | ✅ | via `@vitejs/plugin-rsc` |
| Env vars / `NEXT_PUBLIC_*` | ✅ | "Auto-loads Next.js-style dotenv files; only public vars are inlined" |
| Route segment config | 🟡 | "`revalidate`, `dynamic`, `dynamicParams`. **`runtime` and `preferredRegion` are ignored**" |
| `next/font/google` | 🟡 | "Runtime CDN loading. No self-hosting, font subsetting, or fallback metrics" |
| `next/image` | 🟡 | irrelevant for us — we render inline SVG, not `<Image>` |
| ISR / `"use cache"` | 🟡 | irrelevant for us; also see gotcha G3 |

Verdict for our feature set: everything we need is in the ✅ column. The 🟡/❌ column is
almost entirely stuff we don't touch. **Our exposure to vinext's beta risk is unusually
low**, which is the strongest single argument for picking vinext over OpenNext if we stay on
Next.js.

The one 🟡 that could bite: `next/font/google` loads fonts from the CDN at runtime instead of
self-hosting. A pixel-art game will want a self-hosted bitmap/pixel font anyway — put the
`@font-face` in plain CSS with the woff2 in `public/`, don't use `next/font`.

---

## 4. Route handlers under vinext

They are ordinary Next.js App Router route handlers — vinext does not change the authoring
model. Verbatim from the vinext in-repo agent skill
(`.agents/skills/migrate-to-vinext/references/config-examples.md`):

```ts
// app/api/data/route.ts (route handler)
import { env } from "cloudflare:workers";

export async function GET() {
  const value = await env.CACHE.get("key");
  return Response.json({ value });
}
```

Named HTTP method exports (`GET`, `POST`, …) work; `OPTIONS` and `HEAD` are auto-generated
(README API table). There is a live REST-API example deployed at
`realworld-api-rest.vinext.workers.dev` from `examples/`.

`export const runtime = "edge"` / `"nodejs"` is **ignored** by vinext (no error, no effect).
For comparison, OpenNext *requires* you to delete it — OpenNext get-started step 9, verbatim:
*"Remove any `export const runtime = "edge";` if present… The edge runtime is not supported
yet with `@opennextjs/cloudflare`."* Either way: don't write it.

---

## 5. Accessing bindings (KV, secrets, Rate Limiting) from server code

### vinext — verbatim from the README

> Use `import { env } from "cloudflare:workers"` to access bindings in any server component,
> route handler, or server action. No custom worker entry or special configuration required.

```tsx
import { env } from "cloudflare:workers";

export default async function Page() {
  const result = await env.DB.prepare("SELECT * FROM posts").all();
  return <div>{JSON.stringify(result)}</div>;
}
```

> This works because `@cloudflare/vite-plugin` runs the RSC environment in workerd, where
> `cloudflare:workers` is a native module. In production builds, the import is externalized
> so workerd resolves it at runtime. All binding types are supported: D1, R2, KV, Durable
> Objects, AI, Queues, Vectorize, Browser Rendering, etc.

And the explicit anti-pattern warning, verbatim:

> **Note:** You do not need `getPlatformProxy()`, a custom worker entry with
> `fetch(request, env)`, or any other workaround. `cloudflare:workers` is the recommended way
> to access bindings in vinext.

The agent skill repeats it harder:

> Do NOT use `getPlatformProxy()`, `getRequestContext()`, or custom worker entries with
> `fetch(request, env)`. These are older patterns. `cloudflare:workers` is the recommended
> approach.

Types: `wrangler types` — README: *"For TypeScript types, generate them with `wrangler types`
and the `env` import will be fully typed."*

### OpenNext — different API, verbatim from opennext.js.org/cloudflare/bindings

```javascript
import { getCloudflareContext } from "@opennextjs/cloudflare";

export async function GET(request) {
  const myKv = getCloudflareContext().env.MY_KV_NAMESPACE;
  await myKv.put("foo", "bar");
  const foo = await myKv.get("foo");

  return new Response(foo);
}
```

```javascript
const { env, cf, ctx } = getCloudflareContext();
```

For SSG routes OpenNext needs the async form: `await getCloudflareContext({ async: true })`.
OpenNext also requires a `next.config.ts` hook for local dev bindings — verbatim from
get-started step 12:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;

import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
```

**This is the single biggest DX difference.** vinext: one import, works in dev and prod,
nothing to bootstrap. OpenNext: a package-specific accessor, a sync/async split, and a config
hook. If we ever migrate between them, every binding call site changes.

### Secrets

Two mechanisms, both plain bindings, so both reachable through `env` from
`cloudflare:workers`:

1. **Worker secrets** — `wrangler secret put TREASURY_SECRET_KEY`. Appears on `env` as a
   string. Locally, put it in `.dev.vars` (which is git-ignored). Not declared in
   `wrangler.jsonc`.
2. **Secrets Store bindings** — declared in config. Authoritative shape from
   `wrangler@4.127.1/config-schema.json`:

   ```jsonc
   {
     "secrets_store_secrets": [
       { "binding": "TREASURY_KEY", "store_id": "<store-id>", "secret_name": "treasury-signer" }
     ]
   }
   ```

   Schema note, verbatim: *"NOTE: This field is not automatically inherited from the top level
   environment, and so must be specified in every named environment."* That matters if we run
   a `preview` env — the secret binding must be repeated inside `env.preview`.

### Rate Limiting binding

Authoritative shape from `wrangler@4.127.1/config-schema.json` (`period` enum is `[10, 60]`,
nothing else is valid):

```jsonc
{
  "ratelimits": [
    { "name": "FAUCET_LIMITER", "namespace_id": "1001", "simple": { "limit": 100, "period": 60 } }
  ]
}
```

Usage, verbatim from Cloudflare docs:

```ts
const { success } = await env.MY_RATE_LIMITER.limit({ key: pathname })
```

Status: requires wrangler >= 4.36.0 (*"You must use version 4.36.0 or later of the Wrangler
CLI"*). *(Corrected 2026-08-31: the original said "Status: GA." The docs page carries no
GA/beta/stability label either way — treat GA as unverified, not as a documented fact. It does
not change the decision; the per-colo caveat below is what matters.)* **Critical caveat,
verbatim from the docs:** *"For
each unique key you pass to your rate limiting binding, there is a unique limit per Cloudflare
location."* It is per-colo, not global. Two bindings sharing a `namespace_id` share counters
for a key — *"even across different Workers on the same account."*

For HEARTROT this matters: the Rate Limiting binding is fine as cheap spam damping on
`session/init` and `match/start`, but it is **not** an adequate global cap on
`faucet/status` → treasury spend. A determined abuser hitting many colos multiplies their
allowance by the number of Cloudflare locations they can reach. If treasury drain is the
threat model, the counter must live in something globally consistent — a Durable Object per
funding epoch, or a KV counter accepting eventual-consistency slop.

---

## 6. vinext build + deploy pipeline

Setup, verbatim (README quick start):

```bash
pnpm create vinext-app@latest my-app     # new project
npx vinext init                          # migrate an existing Next.js project
npx vinext check                         # compatibility scan, run before init
```

Manual install, verbatim:

```bash
npm install vinext
npm install -D vite @vitejs/plugin-react
# App Router also needs:
npm install react-server-dom-webpack
npm install -D @vitejs/plugin-rsc
```

Scripts, verbatim:

```json
{
  "scripts": {
    "dev": "vinext dev",
    "build": "vinext build",
    "start": "vinext start"
  }
}
```

CLI, verbatim from the README table: `vinext dev` (HMR), `vinext build` (multi-environment
for App Router: RSC + SSR + client), `vinext start` (local production server),
`npx @vinext/cloudflare deploy`, `vinext init`, `vinext check`, `vinext lint`.
Deploy flags: `--preview`, `--env <name>`, `--name <name>`, `--skip-build`, `--dry-run`,
`--experimental-tpr`.

`vite.config.ts` for App Router on Workers, verbatim:

```ts
import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    vinext(),
    cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
});
```

With the loud warning, verbatim:

> **Do not register `@vitejs/plugin-rsc` yourself.** It is an optional peer dependency, so it
> must be _installed_ in your project, but vinext auto-registers it whenever an `app/`
> directory is detected. Adding an explicit `rsc()` call fails the build with
> `[vinext] Duplicate @vitejs/plugin-rsc detected`. Pass `rsc: false` to `vinext()` only if
> you want to own that registration.

`wrangler.jsonc` generated by `vinext init --platform=cloudflare`, verbatim from the in-repo
agent skill:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "my-app",
  "compatibility_date": "2026-02-12",
  "compatibility_flags": ["nodejs_compat"],
  "main": "vinext/server/app-router-entry",
  "assets": {
    "not_found_handling": "none",
  },
}
```

Note `"main": "vinext/server/app-router-entry"` — vinext supplies the Worker entry; you do not
write a `fetch(request, env, ctx)` handler.

### Cache adapters (only relevant if we ever use ISR / `"use cache"`)

Verbatim from the README:

```ts
import { defineConfig } from "vite";
import vinext from "vinext";
import { cdnAdapter } from "@vinext/cloudflare/cache/cdn-adapter";
import { kvDataAdapter } from "@vinext/cloudflare/cache/kv-data-adapter";

export default defineConfig({
  plugins: [
    vinext({
      cache: {
        cdn: cdnAdapter(),
        data: kvDataAdapter(),
      },
    }),
  ],
});
```

```jsonc
{
  "kv_namespaces": [{ "binding": "VINEXT_KV_CACHE", "id": "<your-namespace-id>" }],
}
```

`cdnAdapter()` additionally needs `"cache": { "enabled": true }` in `wrangler.jsonc` (it uses
`ctx.cache`). Defaults: binding name `VINEXT_KV_CACHE`, 30-day KV `expirationTtl`, 5s
in-memory tag cache. **HEARTROT needs none of this** — our data lives on-chain and in the ER.

---

## 7. OpenNext, honestly

OpenNext is not the loser here; it is the mature option that Cloudflare has stopped
recommending for *new* apps. Cloudflare's own reasoning, verbatim from the announcement blog:

> Building on top of Next.js output as a foundation has proven to be a difficult and fragile
> approach.

And vinext's own README is unusually fair about it, verbatim:

> **[OpenNext](https://opennext.js.org/)** — adapts `next build` output for AWS, Cloudflare,
> and other platforms. OpenNext has been around much longer than vinext, is more mature, and
> covers more of the Next.js API surface because it builds on top of Next.js's own output
> rather than reimplementing it. If you want the safer, more proven option, start there.

> If you need a mature, well-tested way to run Next.js outside Vercel, OpenNext is the safer
> choice. If you want a lighter Vite-based toolchain and do not need every Next.js API, vinext
> may be a good fit.

**OpenNext is actively maintained.** Release history from the GitHub API:

```
@opennextjs/cloudflare@1.20.5  2026-08-31
@opennextjs/cloudflare@1.20.4  2026-08-27
@opennextjs/cloudflare@1.20.3  2026-08-26
@opennextjs/cloudflare@1.20.2  2026-07-21
@opennextjs/cloudflare@1.20.1  2026-06-26
@opennextjs/cloudflare@1.20.0  2026-06-25
```

12 commits to `main` in August 2026. Next.js support, verbatim from opennext.js.org/cloudflare:
*"All minor and patch versions of Next.js 16 and the latest minors of Next.js 14 and 15 are
supported. Next.js 14 support will be dropped Q1 2026."* Its docs make no mention of vinext.

OpenNext setup, verbatim from `pages/cloudflare/get-started.mdx`:

```sh
npx @opennextjs/cloudflare migrate     # automates all manual steps
```

```jsonc
// wrangler.jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "main": ".open-next/worker.js",
  "name": "my-app",
  "compatibility_date": "2024-12-30",
  "compatibility_flags": [
    "nodejs_compat",
    "global_fetch_strictly_public",
  ],
  "assets": {
    "directory": ".open-next/assets",
    "binding": "ASSETS",
  },
  "services": [
    { "binding": "WORKER_SELF_REFERENCE", "service": "my-app" },
  ],
  "r2_buckets": [],
  "images": { "binding": "IMAGES" },
}
```

```ts
// open-next.config.ts
import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";

export default defineCloudflareConfig({
  incrementalCache: r2IncrementalCache,
});
```

```json
// package.json scripts
{
  "build": "next build",
  "preview": "opennextjs-cloudflare build && opennextjs-cloudflare preview",
  "deploy": "opennextjs-cloudflare build && opennextjs-cloudflare deploy",
  "upload": "opennextjs-cloudflare build && opennextjs-cloudflare upload",
  "cf-typegen": "wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts"
}
```

```plain
// public/_headers
/_next/static/*
  Cache-Control: public,max-age=31536000,immutable
```

Plus a `.dev.vars` with `NEXTJS_ENV=development`, and `.open-next` in `.gitignore`.

### Side-by-side

| | vinext | OpenNext |
| --- | --- | --- |
| Version (2026-08-31) | `1.0.0-beta.8` | `1.20.5` |
| Approach | reimplements Next.js API on Vite | re-hosts `next build` output |
| Cloudflare's recommendation | **default for new apps** | fallback for existing apps |
| Requires `next` installed | no | yes (`>=15.5.24 <16 \|\| >=16.3.3`) |
| Build speed | 4.4× faster than Next 16 (their bench, 33-route app, `force-dynamic`) | `next build` speed |
| Client bundle | 57% smaller gzipped (their bench) | Next.js output |
| Bindings API | `import { env } from "cloudflare:workers"` | `getCloudflareContext().env` |
| Local dev bindings | automatic | needs `initOpenNextCloudflareForDev()` in `next.config.ts` |
| Edge runtime export | ignored | must be removed |
| Extra config files | `vite.config.ts` (optional), `wrangler.jsonc` | `open-next.config.ts`, `wrangler.jsonc`, `.dev.vars`, `public/_headers` |
| Build-time prerender | opt-in, and broken with `cloudflare:workers` imports (G3) | standard Next.js prerender |
| Worker size ceiling | same platform limit (3 MiB free / 10 MiB paid) | same, and OpenNext bundles are chunkier |
| API coverage | ~94% of Next 16 surface (self-reported) | broader — it *is* Next.js output |
| Maturity | ~6 months old, beta | years, 1.x stable |

Their benchmark caveat, verbatim, because it matters:

> **Caveat:** Benchmarks are hard to get right and these are early results. Take them as
> directional, not definitive.
>
> These benchmarks measure **compilation and bundling speed**, not production serving
> performance.

---

## 8. Recommended wrangler configs for HEARTROT

### 8a. The lazy path — Vite SPA + one Worker (recommended)

No Next.js, no adapter, no beta framework. The game shell and the SVG sprite rig are static
assets (free, unbilled, never invoke the Worker). The Worker runs only for the 4 cold-path
routes.

```jsonc
// wrangler.jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "heartrot",
  "main": "./worker/index.ts",
  "compatibility_date": "2026-08-31",
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "kv_namespaces": [
    { "binding": "SESSIONS", "id": "<kv-namespace-id>" }
  ],
  "ratelimits": [
    { "name": "FAUCET_LIMITER", "namespace_id": "1001", "simple": { "limit": 10, "period": 60 } }
  ],
  "observability": { "enabled": true }
}
```

Notes on every field:
- `compatibility_date` >= `2026-08-04` means **`nodejs_compat` is on by default** — Cloudflare
  docs, verbatim: *"For compatibility dates of `2026-08-04` or later, Workers enables both
  `nodejs_compat` and `nodejs_compat_v2` by default… Omit them from new configurations."*
  So no `compatibility_flags` line at all.
- `not_found_handling` enum is exactly `["single-page-application", "404-page", "none"]`
  (wrangler schema). SPA mode serves `index.html` for unmatched paths — correct for a canvas
  game with client routing.
- `run_worker_first: ["/api/*"]` sends only our 4 routes to the Worker. Everything else is
  asset-first and free.
- Rate limiter `period` must be `10` or `60`. Nothing else validates.

The Worker is then a plain `fetch` handler with 4 branches — no framework, ~80 lines. See
`§5` for the rate-limit and secret access patterns.

**Free-tier trap** (docs, verbatim): *"When using `run_worker_first`, requests matching the
specified patterns will always invoke your Worker script. If you exceed your free tier request
limits, these requests will receive a 429 (Too Many Requests) response instead of falling back
to static asset serving."* Only the 4 API routes are affected, which is the correct failure
mode anyway.

### 8b. If we stay on Next.js — vinext

```jsonc
// wrangler.jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "heartrot",
  "main": "vinext/server/app-router-entry",
  "compatibility_date": "2026-08-31",
  "assets": {
    "not_found_handling": "none"
  },
  "kv_namespaces": [
    { "binding": "SESSIONS", "id": "<kv-namespace-id>" }
  ],
  "ratelimits": [
    { "name": "FAUCET_LIMITER", "namespace_id": "1001", "simple": { "limit": 10, "period": 60 } }
  ],
  "observability": { "enabled": true }
}
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    vinext(),
    cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
});
```

```ts
// app/api/session/init/route.ts
import { env } from "cloudflare:workers";
import { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  const { success } = await env.FAUCET_LIMITER.limit({ key: req.headers.get("cf-connecting-ip") ?? "anon" });
  if (!success) return new Response("rate limited", { status: 429 });
  // ... treasury-funded session wallet provisioning
  return Response.json({ ok: true });
}
```

Deploy: `npx @vinext/cloudflare deploy` (add `--env preview` for a staging Worker).
Do **not** deploy with `wrangler deploy` directly — the build emits its own generated
`wrangler.json` (see G2).

---

## 9. Gotchas and failure modes

**G1 — every page load is a Worker invocation under vinext.**
README `:751`, verbatim: *"vinext server-renders all pages on each request."* Build-time
prerender is opt-in. Exact shapes, read out of the shipped `vinext@1.0.0-beta.8` tarball
(`dist/index.d.ts`, `dist/cli-args.js` — **not** documented in the README, so don't look for
them there):

- CLI flag `--prerender-all`, valid on both `vinext build` and `vinext deploy`.
- Vite-plugin option, **not** a `next.config` key: `vinext({ prerender: true })`, shorthand for
  `vinext({ prerender: { routes: "*" } })`. Verbatim from the type doc: *"The object form is
  available so future releases can support narrower route selections, but currently only `"*"`
  is supported."* The CLI flags *"take priority when present."*
- `output: 'export'` (see G5 for what that costs). For a game whose HTML shell never
changes, this is pure waste: billed requests and an SSR round-trip on the critical path
before the canvas can even mount. Mitigations, in order of laziness: (a) don't use Next
(§8a); (b) accept it and note that a game session is one page load, so the absolute cost is
small; (c) `--experimental-tpr`, which needs a custom domain and a zone-analytics API token.

**G2 — `vinext init` generates a broken deploy script.** Open issue
[#2965](https://github.com/cloudflare/vinext/issues/2965), verbatim: `init --platform
cloudflare` writes `"deploy:vinext": "vinext-cloudflare deploy --config
dist/server/wrangler.json"` but the build actually emits `dist/<worker-name>/wrangler.json`.
*"`dist/server/wrangler.json` does not exist, so the scaffolded deploy script cannot work as
generated. It only coincides for a project whose Worker happens to be named `server`."*
Related: [#2966](https://github.com/cloudflare/vinext/issues/2966) — `vinext start` runs the
Node server for Cloudflare projects and can't find the Worker build. Both open as of
2026-08-31. **Check the generated scripts after `vinext init`; don't trust them.**

**G3 — opting into build-time prerender crashes if any server module imports
`cloudflare:workers`.** Open issue
[#2911](https://github.com/cloudflare/vinext/issues/2911), verbatim: *"Any user module in the
server graph that does `import { env } from "cloudflare:workers"` — the documented,
recommended way to access Cloudflare bindings in vinext — throws `ERR_MODULE_NOT_FOUND` at
module-load time, before a single route renders."* This is exactly HEARTROT's shape: 4 route
handlers using bindings + a shell we'd want prerendered. So the obvious "just prerender the
shell to get free static assets" workaround for G1 **does not currently work**. The
maintainers' proposed fix is to prerender against the deployed Worker instead of bare Node;
not shipped.

**G4 — ISR on Cloudflare is reported broken.** Open issue
[#2983](https://github.com/cloudflare/vinext/issues/2983) (2026-08-18), verbatim:
*"Can't run sample project that uses ISR on Cloudflare via @vinext/cloudflare 1.0.0-beta.6…
Current: 500 response code, no root cause in logs."* We don't use ISR — but this is a
reasonable proxy for "the Cloudflare-specific caching paths are still shaking out."

**G5 — `output: "export"` cannot host *our* route handlers.** *(Corrected 2026-08-31 — the
original claim "cannot host route handlers" was wrong.)* Static export **does** support route
handlers, with two hard limits, verbatim from the Next.js 16.3.3 static-export guide:

> Route Handlers will render a static response when running `next build`. Only the `GET` HTTP
> verb is supported. […] To ensure Route Handlers are prerendered, you must explicitly mark
> the handler as static by adding `export const dynamic = 'force-static'`. […] **If you need to
> read dynamic values from the incoming request, you cannot use a static export.**

and in the Unsupported Features list: *"Route Handlers that rely on `Request`"*, plus
*"Cookies"*, *"Server Actions"*, *"Rewrites"*, *"Redirects"*, *"Headers"*.

All four of our cold-path routes read the incoming request (`session/init` takes a session
pubkey, `match/start` and `match/settle` take a body, `faucet/status` takes a wallet address),
so all four are outside static export. The conclusion is unchanged — a static export plus the
4 routes means two separate Workers, more moving parts than §8a's single Worker — but the
reason is "these handlers read `Request`", not "route handlers are banned". If a future route
is a build-time constant (say a public config blob), `force-static` GET export is legal.

**G6 — the `not_found_handling: "none"` in vinext's generated config is deliberate.** It means
unmatched paths go to the Worker to be SSR'd / 404'd by Next's router. Don't "fix" it to
`"single-page-application"` in a vinext project; that would shadow the Next router.

**G7 — third-party vinext docs are hallucinating APIs.** `mintlify.wiki` mirrors document
`getEnv()` from `vinext/cloudflare` for bindings. That export does not exist. Re-verified
2026-08-31 against the published tarballs, and it is worse than "wrong name": (a) the package
is `@vinext/cloudflare`, not `vinext/cloudflare`; (b) `@vinext/cloudflare@1.0.0-beta.6` has
**no root `"."` export at all** — its `exports` map is only `./internal/*`, `./cache/*`,
`./images/*` — so `import { getEnv } from "@vinext/cloudflare"` fails at module resolution
before any type error; (c) the only `getEnv` string in the package is an internal identifier
inside `dist/deploy.js`, a deploy-time helper, never a runtime bindings API; (d) `vinext`
itself contains no `getEnv` at all. Use `import { env } from "cloudflare:workers"`. Similarly `vinext.io` self-describes as
unaffiliated with Cloudflare. Canonical sources: `github.com/cloudflare/vinext`,
`vinext.dev`, `developers.cloudflare.com`.

**G8 — Worker size limit.** 3 MiB (free) / 10 MiB (paid), gzipped. Only bites if the 4 routes
pull in a fat Solana dependency. Use **`@solana/kit`** (latest `8.2.0`, published 2026-08-29,
`engines.node >=20.18.0`, ~27 tree-shakeable `@solana/*` sub-packages). Do **not** use
`@solana/web3.js` classic: its `latest` dist-tag is still `1.98.4`, last published
**2025-07-31** — over a year stale — and it is a single monolithic bundle. (`web3.js` has a
`3.0.0-rc.2` on the `rc` tag; `latest` has not moved.) Worth measuring early — this constraint
is identical across all three paths, so it doesn't affect the choice, only the dependency
picks. **Unverified**: I did not measure a real bundle.

**G12 — Solana signing in the Workers runtime: Ed25519 works, but raw private-key import does
not.** This is the "works in Node, not in workerd" trap, and it was unexamined in the original
research. Verified from `runtime-apis/web-crypto.mdx:523`: the Workers WebCrypto supported-
algorithms table lists **`Ed25519`** (Secure Curves) with ✓ for `sign()/verify()`,
`generateKey()`, `exportKey()` and `importKey()`. So the treasury key can be held and used to
sign inside the Worker with no Node polyfill and no `nodejs_compat` flag.

The trap is the key material format. A Solana secret key is a raw 32-byte seed, and the
Workers docs say verbatim (footnote 2, `web-crypto.mdx:547-548`): *"Unlike NodeJS, Cloudflare
will not support raw import of private keys."* So this **fails in a Worker**:

```ts
// ✗ throws — raw private-key import is not supported in workerd
await crypto.subtle.importKey("raw", secret32, "Ed25519", false, ["sign"]);
```

The private key must be wrapped in PKCS#8 DER (or JWK) first. `@solana/kit` already does
this — verified by unpacking the published `@solana/keys` tarball: `createKeyPairFromBytes` /
`createKeyPairFromPrivateKeyBytes` call `importKey` with `"pkcs8"`, not `"raw"`. **Conclusion:
use `@solana/kit`'s key helpers in the Worker; do not hand-roll `crypto.subtle.importKey`.**
Hand-rolling is the single most likely way this project loses a day to a workerd-only failure.
This applies identically to §8a and §8b — it is a runtime fact, not a framework fact.

**G9 — Node 22 and Vite 8 are hard requirements for vinext.** `"engines": {"node": ">=22"}`,
peer `vite: "^8.0.0"`. Vite 8 is a major bump; any Vite 7 plugin in the tree needs checking.

**G10 — the Rate Limiting binding is per-Cloudflare-location.** See §5. Do not use it as the
only guard on treasury spend.

**G11 — stale `nodejs_compat` in every template.** All vinext and OpenNext templates ship
`compatibility_date` in the past plus `"compatibility_flags": ["nodejs_compat"]`. With a
`compatibility_date` of `2026-08-04` or later, the flag is redundant (docs: *"Omit them from
new configurations"*). Harmless if left, but if you copy a template's old
`compatibility_date` verbatim you also inherit months of old runtime semantics.

---

## 10. How this connects to the rest of HEARTROT — and where it contradicts the spec

### Connections

- **The 4 cold-path routes** (`session/init`, `match/start`, `match/settle`, `faucet/status`)
  are the only thing that ever needs the Worker. Under §8a they are 4 branches of one
  `fetch`; under §8b they are 4 `route.ts` files. Either way the code inside is identical.
- **"Gameplay txs never pass through the backend"** is enforced structurally in §8a by
  `run_worker_first: ["/api/*"]` — nothing but `/api/*` can reach the Worker, so there is no
  accidental path for gameplay traffic to acquire a Worker hop. In §8b there is no such
  boundary; every request lands in the Next router. Small point in §8a's favour.
- **The SVG sprite rig** produced by `tools/px2svg.py` is static output. It belongs in
  `public/` (or Vite's asset pipeline) and should be served as a static asset — free,
  unbilled, cached at the edge. Do **not** route it through a Next `<Image>` or any runtime
  optimizer; vinext's image path is request-time and would turn free asset requests into
  billed Worker invocations. Inline `<svg>` / `<g>` nodes, as the spec already specifies, is
  the right call.
- **Treasury signing key** → Worker secret (`wrangler secret put`) or a Secrets Store binding.
  Reachable via `env` in both §8a and §8b. Never `NEXT_PUBLIC_*` — vinext inlines every
  `NEXT_PUBLIC_*` var into the client bundle by design (README: *"only public vars are
  inlined"*, so anything else stays server-side, but the naming convention is the whole
  guard — one typo ships the treasury key to the browser).
- **Faucet abuse control** → Rate Limiting binding for cheap damping, a DO or KV counter for
  the real global cap (§5).
- **The browser-side airdrop tier** (each user brings their own IP) is unaffected by this
  choice — it runs in the browser, not the Worker, exactly as the spec intends. The
  reasoning in the spec ("a Worker shares Cloudflare egress IPs") is correct and holds under
  all three deployment paths.
- **Privy embedded wallet** is a client-side SDK; it does not care which of the three paths
  we pick. Session keypair generation stays in the browser.

### Contradictions with the frozen design assumptions

1. **"Frontend: Next.js deployed on Cloudflare Workers."** The research says Next.js buys us
   nothing here and costs us a billed Worker invocation per page load plus a beta framework
   in the deploy path. A Vite SPA + one Worker delivers the same product with strictly less
   machinery. This is a *soft* contradiction — Next.js will work fine — but it is the one
   place in the frontend spec where the simpler option is clearly available.
2. **"Next.js deployed on Cloudflare Workers"** — if the spec was written assuming OpenNext,
   it is now describing the non-recommended path. Cloudflare's guide reserves OpenNext for
   *existing* apps that can't migrate. HEARTROT is a new app, so the OpenNext justification
   does not apply to it.
3. **Nothing else in the spec conflicts.** The "4 cold-path routes, gameplay bypasses the
   backend" split is exactly the shape all three paths handle well, and the static-asset
   billing model actively rewards it.

---

## 11. Open questions / what I could not verify

- **Actual cold-start and TTFB of a vinext Worker vs a static asset response.** The published
  benchmarks explicitly measure build/bundle time only ("These benchmarks measure compilation
  and bundling speed, not production serving performance"). I did not run a latency
  measurement. Confidence: **low** on any serving-performance claim.
- **Real Worker bundle size for our 4 routes with a Solana dependency.** Not measured (G8).
- **Whether `--experimental-tpr` would let us prerender just `/` and get the shell served
  from KV.** Plausible from the README description, but TPR requires a custom domain and
  zone-analytics permissions, and its interaction with G3 (`cloudflare:workers` in the server
  graph) is untested by me. Confidence: **low**.
- **Whether vinext will hit 1.0.0 stable before our launch.** 76 versions in ~6 months,
  weekly beta cadence, no announced GA date found.
- **`@vinext/cloudflare` was last published 2026-08-15 while `vinext` shipped 2026-08-20.**
  *(Partially resolved 2026-09-01: `@vinext/cloudflare@1.0.0-beta.6` declares
  `"peerDependencies": { "vinext": "^1.0.0-beta.6" }`, and under semver a caret range on a
  prerelease admits later prereleases of the same version, so `1.0.0-beta.8` **satisfies** it —
  the pair is declared-compatible and npm/pnpm will not warn. What is still untested is
  behavioural skew, and issue #2983 is filed against beta.6.)* Pin both and test the deploy
  early.

---

## Sources

Every URL below was actually fetched and read on 2026-08-31.

**vinext (primary)**
- https://github.com/cloudflare/vinext
- https://raw.githubusercontent.com/cloudflare/vinext/main/README.md (full 917-line README, via GitHub contents API)
- `repos/cloudflare/vinext/contents/.agents/skills/migrate-to-vinext/references/config-examples.md` (in-repo agent skill, via GitHub API)
- `repos/cloudflare/vinext/contents/packages/{vinext,cloudflare,types,create-vinext-app}/package.json` (via GitHub API)
- https://github.com/cloudflare/vinext/issues/2911
- https://github.com/cloudflare/vinext/issues/2965
- https://github.com/cloudflare/vinext/issues/2983
- Open-issue listing via `gh search issues --repo cloudflare/vinext --state open`
- https://blog.cloudflare.com/vinext/
- https://vinext.dev/
- https://vinext.dev/compatibility
- https://vinext.io/ (checked — self-describes as unaffiliated with Cloudflare; not authoritative)
- https://mintlify.wiki/cloudflare/vinext/api/cloudflare/bindings (checked — documents a non-existent `getEnv()` API; **do not use**)

**Cloudflare docs (primary)**
- https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/
- `repos/cloudflare/cloudflare-docs/contents/src/content/docs/workers/framework-guides/web-apps/nextjs.mdx` (source of the above, read verbatim)
- `repos/cloudflare/cloudflare-docs/contents/src/content/docs/workers/static-assets/billing-and-limitations.mdx`
- `repos/cloudflare/cloudflare-docs/contents/src/content/docs/workers/static-assets/binding.mdx`
- `repos/cloudflare/cloudflare-docs/contents/src/content/docs/workers/runtime-apis/nodejs/index.mdx`
- https://developers.cloudflare.com/workers/static-assets/routing/worker-script/
- https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/

**OpenNext (primary)**
- https://opennext.js.org/cloudflare
- https://opennext.js.org/cloudflare/get-started
- https://opennext.js.org/cloudflare/bindings
- `repos/opennextjs/docs/contents/pages/cloudflare/get-started.mdx` (source, read verbatim)
- `repos/opennextjs/docs/contents/pages/cloudflare/caching.mdx` (source, read verbatim)
- `repos/opennextjs/opennextjs-cloudflare` releases + commit history via GitHub API

**Registries / schemas (authoritative for versions)**
- https://registry.npmjs.org/vinext
- https://registry.npmjs.org/@opennextjs/cloudflare
- https://registry.npmjs.org/{vite,wrangler,next,@cloudflare/vite-plugin,@vitejs/plugin-rsc,@vinext/cloudflare,create-vinext-app}
- https://unpkg.com/wrangler@4.127.1/config-schema.json (authoritative `not_found_handling`, `ratelimits`, `secrets_store_secrets` shapes)

---

## Verification

Adversarial re-check, **2026-08-31**, by a second pass that fetched every load-bearing source
itself rather than trusting the list above. Method: `curl` against `registry.npmjs.org`,
`raw.githubusercontent.com/cloudflare/cloudflare-docs@production`,
`api.github.com/repos/cloudflare/vinext/issues/*`, `unpkg.com/wrangler@4.127.1/config-schema.json`,
`nextjs.org/docs`, and — for the API-existence questions — by downloading and unpacking the
actual published npm tarballs of `vinext@1.0.0-beta.8` and `@vinext/cloudflare@1.0.0-beta.6`
and grepping `dist/`.

### Confirmed verbatim (no change)

- **Cloudflare recommends vinext.** `nextjs.mdx:19`, exact: *"Cloudflare recommends
  [vinext](https://vinext.dev/) as the default way to run Next.js applications on Cloudflare
  Workers."* The OpenNext carve-out is `nextjs.mdx:207`, exact: *"You maintain an existing
  OpenNext application that cannot yet migrate to vinext because of a compatibility gap."*
  This was the single highest-stakes claim (a fabricated framework would have wrecked the
  whole doc) and it holds.
- **Every version number.** `vinext` dist-tag `latest` = `1.0.0-beta.8`, published
  `2026-08-20T13:19:33Z`, 76 versions. `@vinext/cloudflare` `1.0.0-beta.6` (`2026-08-15`).
  `create-vinext-app` `1.0.0-beta.2` (`2026-08-07`). `@opennextjs/cloudflare` `1.20.5`
  (`2026-08-31T17:54:38Z`), with `1.20.4` on 08-27 and `1.20.3` on 08-26 — OpenNext is
  demonstrably alive. `next` 16.3.3, `vite` 8.2.2, `wrangler` 4.127.1,
  `@cloudflare/vite-plugin` 1.54.2. All exact.
- **vinext peer/engine metadata for beta.8**: `engines.node ">=22"`, `vite "^8.0.0"`,
  `react`/`react-dom` `"^19.2.6"`, `@vitejs/plugin-rsc "^0.5.34"`,
  `react-server-dom-webpack "^19.2.6"`, `@vitejs/plugin-react "^5.1.4 || ^6.0.0"`. Verified
  against the registry JSON directly, not a summarizer — a first pass through a summarizing
  fetch returned an *older* version's peers (`vite: "^7.0.0 || ^8.0.0"`, `react: ">=19.2.0"`)
  and would have produced a wrong pin. If you re-check these, read the raw registry JSON.
- **`@opennextjs/cloudflare@1.20.5` peers**: `next ">=15.5.24 <16 || >=16.3.3"`,
  `wrangler "^4.125.0"`; bundled `@opennextjs/aws` `4.1.3`.
- **The decisive README quote**, `README.md:751`, exact and in full context (it lives in the
  *benchmark* caveat, which is worth knowing but does not weaken it): *"Next.js statically
  pre-renders pages at build time (making builds slower but production serving faster for
  static content), while vinext server-renders all pages on each request."*
- **Bindings API.** `README.md:305`: *"Use `import { env } from "cloudflare:workers"` to access
  bindings in any server component, route handler, or server action."* `README.md:332`: *"You
  do not need `getPlatformProxy()`, a custom worker entry with `fetch(request, env)`, or any
  other workaround."* Corroborated independently by the Cloudflare doc's support table:
  *"Cloudflare bindings | Supported | Use `cloudflare:workers` in server components, route
  handlers, and server actions."* This is the one API HEARTROT's 4 routes depend on, and it is
  confirmed in the Workers runtime, not just in Node — `README.md:316` explains why: *"the RSC
  environment [runs] in workerd, where `cloudflare:workers` is a native module."*
- **Static-asset billing.** `billing-and-limitations.mdx:16`, exact: *"Requests to static
  assets are free and unlimited. Requests to the Worker script (for example, in the case of
  SSR content) are billed according to Workers pricing."*
- **The free-tier 429.** `billing-and-limitations.mdx:18`, exact: *"When using
  `run_worker_first`, requests matching the specified patterns will always invoke your Worker
  script. If you exceed your free tier request limits, these requests will receive a 429 (Too
  Many Requests) response instead of falling back to static asset serving. Negative patterns
  (patterns beginning with `!/`) will continue to serve assets correctly."*
- **The recommended §8a config is literally the documented pattern.**
  `routing/single-page-application.mdx:60-62` ships
  `"not_found_handling": "single-page-application"` next to
  `"run_worker_first": ["/api/*", "!/api/docs/*"]`. We are not inventing a shape.
- **wrangler 4.127.1 schema.** `not_found_handling` enum is exactly
  `["single-page-application", "404-page", "none"]`. `ratelimits[].simple.period` enum is
  exactly `[10, 60]`. `run_worker_first` is `array<string> | boolean`. `secrets_store_secrets`
  requires `binding` + `store_id` + `secret_name` (`additionalProperties: false`) and carries
  the exact note *"This field is not automatically inherited from the top level environment,
  and so must be specified in every named environment."*
- **`nodejs_compat` default.** `runtime-apis/nodejs/index.mdx:23-25`, exact: *"For
  compatibility dates of `2026-08-04` or later, Workers enables both `nodejs_compat` and
  `nodejs_compat_v2` by default. […] Omit them from new configurations."*
- **Rate-limit per-colo caveat.** `rate-limit.mdx:200`, exact: *"For each unique key you pass
  to your rate limiting binding, there is a unique limit per Cloudflare location."* Also
  confirmed: *"You must use version 4.36.0 or later of the Wrangler CLI"*, and the usage line
  `const { success } = await env.MY_RATE_LIMITER.limit({ key: pathname })`.
- **All four open issues, still open on 2026-08-31**, titles and bodies as described:
  #2911 (created 08-13, bare-Node prerender throws `ERR_MODULE_NOT_FOUND` on
  `cloudflare:workers`), #2965 and #2966 (both 08-18, broken scaffolded Cloudflare
  deploy/start scripts), #2983 (08-18, ISR 500 on `@vinext/cloudflare` beta.6). None closed,
  none are PRs.
- **Generated vinext Worker config.** `.agents/skills/migrate-to-vinext/references/config-examples.md`
  has `"main": "vinext/server/app-router-entry"` and `"assets": { "not_found_handling": "none" }`
  — and, confirming G-note about stale templates, `"compatibility_date": "2026-02-12"` with an
  explicit `"compatibility_flags": ["nodejs_compat"]`.
- **Compatibility dashboard**, `vinext.dev/compatibility`, run *Aug 31, 2026, 2:19 AM UTC* vs
  *v16.2.6*, 799 test files: supported pass rate **99.6%**, overall **95.9%**, supported
  surface coverage **93.9%**. App Router 99.7% supported. Route handlers, `next/server`,
  `next/headers`, `next/navigation`, env loading all in the fully-supported column. Note the
  dashboard compares against **16.2.6** while npm `latest` is **16.3.3** — the dashboard is one
  minor behind the release it claims parity with.
- **vinext's own hedges.** `README.md:217`: *"If you need a mature, well-tested way to run
  Next.js outside Vercel, OpenNext is the safer choice."* `README.md:220`: *"You can, with
  caution. vinext has known compatibility gaps and has not yet been battle-tested across the
  full range of production Next.js workloads."* Both exact.

### Corrected in place

1. **G5 — `output: "export"` and route handlers.** The original text said static export
   *"cannot host route handlers"*. That is false. Next.js 16.3.3's static-export guide says
   route handlers **are** exportable — *"Only the `GET` HTTP verb is supported"*, with
   `export const dynamic = 'force-static'` — and separately bans *"Route Handlers that rely on
   `Request`"*. The practical conclusion is unchanged (all four of our routes read the request,
   so none can be static-exported), but the rule now states the real constraint, so a future
   build-time-constant GET route isn't wrongly ruled out. Rewritten with the verbatim quotes.
2. **Rate Limiting "Status: GA".** Removed. The Cloudflare rate-limit page carries **no**
   stability label — not GA, not beta. The wrangler >= 4.36.0 requirement is documented; GA is
   not. Downgraded to unverified and marked as such. Does not affect the decision; the per-colo
   limitation is the load-bearing fact and it is confirmed.
3. **Prerender opt-in shapes.** `--prerender-all` and `prerender: { routes: "*" }` are real —
   but they are **not in the README**, which was the cited source. Found them in the shipped
   `vinext@1.0.0-beta.8` tarball (`dist/index.d.ts`, `dist/cli-args.js`, `dist/config/prerender.js`).
   Added the exact shapes and the fact that `prerender` is a **Vite-plugin option, not a
   `next.config` key** — getting that wrong is a silent no-op. Also recorded the type doc's own
   caveat that *"currently only `"*"` is supported"*.
4. **G7 `getEnv()`.** The claim was right; the evidence was thin (a `gh search code` invocation).
   Replaced with a stronger, reproducible teardown from the tarballs: the specifier
   `vinext/cloudflare` does not exist (the package is `@vinext/cloudflare`);
   `@vinext/cloudflare@1.0.0-beta.6`'s `exports` map has **no root `"."` entry** at all (only
   `./internal/*`, `./cache/*`, `./images/*`), so the import fails at resolution; the sole
   `getEnv` occurrence in the package is an internal identifier in `dist/deploy.js`; and
   `vinext` itself has zero occurrences. Same conclusion, now unfalsifiable-by-inspection.

### Still unverified — do not treat as fact

- **Whether `output: "export"` dodges issue #2911.** The Cloudflare support table says static
  export is *"Supported"*, while #2911 says the build-time prerender server loads the
  workerd-targeted bundle into bare Node and dies on any `cloudflare:workers` import. Those two
  statements are in tension and nothing I read resolves it. Since G5 already rules static export
  out for us, this only matters if someone revives the "static export the shell" plan — and then
  it must be tested, not assumed.
- **Cold-start / TTFB numbers.** Unmeasured, as the original doc said. The README itself
  (`:751`) warns its benchmarks measure *"compilation and bundling speed, not production
  serving performance."* No serving-latency claim in this document has evidence behind it.
- **Gzipped Worker bundle size for the 4 routes with a Solana signing dependency.** Unmeasured.
  The 3 MiB free / 10 MiB paid ceiling is real but our distance from it is unknown.
- **beta.8 ↔ beta.6 version skew** between `vinext` and `@vinext/cloudflare`. Still unknown;
  #2983 is filed against beta.6. Deploy end-to-end early.
- **`--experimental-tpr`** as a near-static-shell escape hatch. `README.md:334-339` confirms the
  flag and that it *"queries Cloudflare zone analytics at deploy time"* and uploads to KV — so
  the custom-domain + zone-analytics-token requirement is real. Its interaction with #2911 is
  untested by me.
- **A vinext 1.0.0 GA date.** Searched; none announced anywhere.

### Forced decision (the doc hedged; it shouldn't)

The original left §0 option 1 at *"medium confidence, since the frozen spec says Next.js"* and
listed "is Next.js frozen?" as an open question for the user. Closing it: **build the Vite SPA
plus one plain Worker (§8a). Do not use Next.js.** The verification did not weaken that case, it
strengthened it — the recommended config turned out to be verbatim Cloudflare's own documented
SPA pattern, while the Next.js path is a `1.0.0-beta.8` framework, 6 months old, no GA date,
with four open Cloudflare-specific issues, whose own README tells you to use something else if
you want proven, and whose compatibility dashboard benchmarks a Next.js minor behind current.
Against all of that, Next.js buys HEARTROT nothing: the app is a client-rendered SVG canvas and
four request-reading route handlers, and the route-handler bodies are byte-identical either way.
The spec line "Frontend: Next.js deployed on Cloudflare Workers" should be amended to "Frontend:
Vite + React SPA on Cloudflare Workers static assets, with one Worker for the 4 cold-path
routes." Escalate to the user only to make that spec amendment, not to decide it.

If the user overrides and keeps Next.js: **vinext, not OpenNext**, for the reasons in §0.2 —
all still verified.

---

## Verification — second adversarial pass (2026-09-01)

A third reader re-fetched every load-bearing source independently rather than trusting either
the original claim list or the first Verification section. Method: `curl` against
`registry.npmjs.org` (raw JSON, no summarizer), `api.github.com/repos/cloudflare/vinext`,
`raw.githubusercontent.com/cloudflare/cloudflare-docs@production`,
`raw.githubusercontent.com/vercel/next.js@canary`, `raw.githubusercontent.com/opennextjs/docs`,
`unpkg.com/wrangler@4.127.1/config-schema.json`, plus downloading and unpacking the published
tarballs of `vinext@1.0.0-beta.8`, `@vinext/cloudflare@1.0.0-beta.6` and `@solana/keys`.

**Nothing in this document was found to be false.** Two things were added; one open question was
partially closed. Details:

### Independently re-confirmed

- **vinext is real and is Cloudflare's.** `api.github.com/repos/cloudflare/vinext` returns
  `full_name: "cloudflare/vinext"`, owner id `314135` (the Cloudflare org). The npm package's
  `0.0.0` release (2026-02) was published under `southpolesteve` with `homepage:
  github.com/southpolesteve/vinext`; from `0.0.1` onward the homepage is
  `github.com/cloudflare/vinext`. So the "rebuilt in one week, then adopted by Cloudflare"
  story in the README checks out against the registry's own history.
- **`nextjs.mdx:19` verbatim**, re-fetched: *"Cloudflare recommends [vinext](https://vinext.dev/)
  as the default way to run Next.js applications on Cloudflare Workers."* And the other-paths
  table: *"You maintain an existing OpenNext application that cannot yet migrate to vinext
  because of a compatibility gap."* Also `nextjs.mdx:33`: *"vinext is in beta."*
- **The Cloudflare support table row for bindings** is exactly *"Cloudflare bindings |
  Supported | Use `cloudflare:workers` in server components, route handlers, and server
  actions."* Corroborates the README independently of the README.
- **Every version and publish timestamp**, from raw registry JSON: `vinext` `1.0.0-beta.8`
  (2026-08-20T13:19:33Z, 76 versions, prior beta.7 on 08-19); `@vinext/cloudflare`
  `1.0.0-beta.6` (2026-08-15, 13 versions); `create-vinext-app` `1.0.0-beta.2` (2026-08-07);
  `@opennextjs/cloudflare` `1.20.5` (2026-08-31T17:54:38Z, 156 versions); `next` `16.3.3`
  (2026-08-25); `vite` `8.2.2` (2026-08-20); `wrangler` `4.127.1` (2026-08-28);
  `@cloudflare/vite-plugin` `1.54.2` (2026-08-28). **No new release of any of these has landed
  as of 2026-09-01** — the doc is current, not stale.
- **`vinext@1.0.0-beta.8` metadata**, raw: `engines.node ">=22"`; peers `vite "^8.0.0"`,
  `react`/`react-dom` `"^19.2.6"`, `@vitejs/plugin-rsc "^0.5.34"`,
  `@vitejs/plugin-react "^5.1.4 || ^6.0.0"`, `react-server-dom-webpack "^19.2.6"`,
  `@mdx-js/rollup "^3.0.0"`. Note `@vitejs/plugin-rsc`, `react-server-dom-webpack` and
  `@mdx-js/rollup` are marked **optional** in `peerDependenciesMeta` — consistent with the
  README's "install it, don't register it" instruction.
- **`@opennextjs/cloudflare@1.20.5` peers**: `next ">=15.5.24 <16 || >=16.3.3"`,
  `wrangler "^4.125.0"`, `rclone.js "^0.6.6"`; bundled `@opennextjs/aws` `4.1.3`.
- **G7 (`getEnv()` does not exist) re-proved from the tarballs, and it is stronger than
  stated.** `vinext@1.0.0-beta.8` publishes **38** export subpaths and **`./cloudflare` is not
  among them** — so the specifier `vinext/cloudflare` that the mintlify.wiki mirror documents
  cannot resolve at all. (It *did* exist back in `vinext@0.0.1`; the mirror appears to have
  scraped a February-era build. That is how the wrong doc got plausible.)
  `@vinext/cloudflare@1.0.0-beta.6`'s exports map is `./cache/*`, `./images/*`,
  `./internal/{tpr,deploy,cdn-warm,deploy-help,deploy-config,version-deploy}` — **no root `"."`
  entry**. `grep -rn getEnv` over the unpacked `vinext` tree returns **zero** hits; over
  `@vinext/cloudflare` it returns only `getWranglerTargetEnv` in `dist/deploy.js`, a deploy-time
  helper. Both halves of the claim hold.
- **Prerender opt-in shapes**, from the unpacked tarball: `dist/cli-args.js:75` handles
  `--prerender-all` → `result.prerenderAll`; `dist/cli.js:540` documents it as *"Pre-render
  discovered routes after building"*; `dist/index.d.ts:98,101` documents
  `vinext({ prerender: true })` and `vinext({ prerender: { routes: "*" } })` as a **plugin**
  option. Confirms the first pass's correction, including that it is not in the README.
- **README quotes.** 917 lines. `:305` *"Use `import { env } from "cloudflare:workers"` to access
  bindings in any server component, route handler, or server action."* `:316` *"…runs the RSC
  environment in workerd, where `cloudflare:workers` is a native module."* `:332` *"You do not
  need `getPlatformProxy()`, a custom worker entry with `fetch(request, env)`, or any other
  workaround."* The "server-renders all pages on each request" sentence is in the **Benchmarks**
  section and is a statement about *defaults* — the doc's G1 already frames it that way, which
  is the honest framing.
- **All four issues still open on 2026-09-01**, none are PRs, none closed: #2911 (08-13,
  *"bare-Node prerender crashes on `cloudflare:workers` imports"* — body confirms
  `ERR_MODULE_NOT_FOUND` at module-load, before any route renders), #2965 and #2966 (both
  08-18, broken generated Cloudflare deploy/start scripts), #2983 (08-18, ISR 500 on beta.6).
- **wrangler 4.127.1 schema**, read directly: `assets.not_found_handling` enum is exactly
  `["single-page-application", "404-page", "none"]`; `assets.run_worker_first` is
  `array<string> | boolean` and **is nested under `assets`**, as §8a has it;
  `ratelimits[].simple` requires `limit` + `period` with `period` enum exactly `[10, 60]` and
  `additionalProperties: false`; `secrets_store_secrets` requires `binding` + `store_id` +
  `secret_name` and carries the verbatim note *"This field is not automatically inherited from
  the top level environment, and so must be specified in every named environment."*
- **§8a is verbatim Cloudflare's own documented pattern.**
  `static-assets/routing/single-page-application.mdx` ships a config with
  `"not_found_handling": "single-page-application"` and `"run_worker_first": ["/api/*",
  "!/api/docs/*"]` side by side. Two details worth knowing that the doc did not mention:
  advanced routing control requires **Wrangler ≥ v4.20.0 and `@cloudflare/vite-plugin` ≥ v1.7.0**
  (we are far past both), and supplying a `run_worker_first` array **disables the automatic
  `Sec-Fetch-Mode: navigate` detection** that SPA mode otherwise uses. For HEARTROT that is the
  desired behaviour — explicit is what makes the "gameplay never hits the backend" boundary a
  boundary — but it is a behaviour change, not just an addition.
- **Static-asset billing** (`billing-and-limitations.mdx:16`) and the **free-tier 429 under
  `run_worker_first`** (`:18`) — both verbatim as quoted, including the tail the doc omits:
  *"Negative patterns (patterns beginning with `!/`) will continue to serve assets correctly."*
- **`nodejs_compat` default** (`runtime-apis/nodejs/index.mdx`): *"For compatibility dates of
  `2026-08-04` or later, Workers enables both `nodejs_compat` and `nodejs_compat_v2` by
  default… Omit them from new configurations."* Exact.
- **Rate limiting** (`rate-limit.mdx`): *"You must use version 4.36.0 or later of the Wrangler
  CLI"* (`:23`); the per-colo caveat at `:200` verbatim, with a worked Sydney example; and the
  shared-counter note at `:150`: *"Two rate limiting bindings that share the same
  `namespace_id` — even across different Workers on the same account — share the same rate limit
  counters for a given key."* The page still carries **no** GA/beta label, so the first pass's
  downgrade of "Status: GA" to unverified was right.
- **G5** (`next.js@canary docs/01-app/02-guides/static-exports.mdx:235`): *"Route Handlers will
  render a static response when running `next build`. Only the `GET` HTTP verb is supported…
  you must explicitly mark the handler as static by adding `export const dynamic =
  'force-static'`"*, and the Unsupported list at `:286` includes *"Route Handlers that rely on
  Request"*. The first pass's correction was right and the original claim was wrong.
- **OpenNext's prerendered HTML really does go through the Worker.**
  `opennextjs/docs pages/cloudflare/caching.mdx` describes SSG/ISR being served from an
  Incremental Cache (R2/KV/D1) inside the Worker, and offers "cache interception" as an opt-in
  *"to avoid calling the `NextServer`"* — i.e. even the fast path is still a Worker invocation,
  just a cheaper one. The doc's §0 claim holds.
- **Compatibility dashboard**: `vinext.dev/compatibility` confirms **799 test files** against
  **Next.js v16.2.6**, split App Router 628 / Pages Router 246 / Mixed 95 / Other 20. The
  headline percentages (99.6 / 95.9 / 93.9) are rendered client-side and I could not read them
  from static HTML — see "still unverified" below.

### Added in place (new material, not corrections)

1. **G12 — Solana signing in workerd.** The single biggest untested runtime assumption in the
   document, and it is now settled in our favour with one landmine attached. Workers WebCrypto
   supports `Ed25519` (Secure Curves) for `sign`/`verify`/`generateKey`/`importKey`/`exportKey`
   (`web-crypto.mdx:523`), so no Node polyfill is needed to sign with the treasury key. **But**
   footnote 2 states verbatim *"Unlike NodeJS, Cloudflare will not support raw import of private
   keys"*, and a Solana secret key is a raw 32-byte seed — so
   `crypto.subtle.importKey("raw", …, "Ed25519", …, ["sign"])` fails in a Worker while working
   in Node. Verified that `@solana/keys` (the `@solana/kit` dependency) already imports via
   `"pkcs8"`, so `createKeyPairFromBytes` / `createKeyPairFromPrivateKeyBytes` are safe. Written
   up as G12.
2. **G8 strengthened with real registry data.** `@solana/kit` `latest` = **8.2.0**
   (2026-08-29, `engines.node >=20.18.0`, ~27 tree-shakeable `@solana/*` sub-packages), while
   `@solana/web3.js` `latest` = **1.98.4**, last published **2025-07-31** — thirteen months
   stale, with `3.0.0-rc.2` parked on the `rc` tag and never promoted. The original doc named
   the right winner for the wrong reason ("heavy"); the stronger reason is that the loser is
   effectively unmaintained on its `latest` tag.

### Open question partially closed

- **beta.6 ↔ beta.8 skew.** `@vinext/cloudflare@1.0.0-beta.6` declares
  `"peerDependencies": { "vinext": "^1.0.0-beta.6" }`. A caret range on a prerelease admits
  later prereleases of the same base version, so `vinext@1.0.0-beta.8` satisfies it: the pair is
  **declared-compatible** and no package manager will warn. That removes the "will this even
  install" half of the worry. The behavioural half stands — #2983 is filed against beta.6 — and
  is moot under the §8a recommendation, which ships neither package.

### Still unverified after two passes

- **The compatibility dashboard's headline percentages.** 799 test files and the Next.js v16.2.6
  target are confirmed from the served HTML; the 99.6% / 95.9% / 93.9% figures are
  client-rendered and I could not confirm them without a browser. Treat them as the first
  pass's reading, not as re-verified. The structural observation is unaffected and still
  matters: the dashboard benchmarks **16.2.6** while npm `latest` is **16.3.3**.
- **Cold-start / TTFB** of a vinext Worker vs a static asset response. Still unmeasured by
  anyone. No serving-latency claim in this document has evidence behind it.
- **Gzipped Worker bundle size** for the 4 routes with `@solana/kit` included. Still unmeasured.
- **Whether `output: "export"` dodges #2911.** Unresolved, and note the Cloudflare support
  table's flat *"Static generation and static export | Supported"* row is in the same tension
  with #2911 that the first pass flagged — the docs table also lists **ISR as "Supported"** while
  #2983 reports ISR returning 500 on Cloudflare. That is a second, independent instance of the
  support table over-promising relative to the open issue list. Weight the issue tracker over the
  table.
- **A vinext 1.0.0 GA date.** None announced.

### Verdict on the forced decision

The first pass forced §8a (Vite SPA + one plain Worker, no Next.js) and that call **stands
un-weakened**. Two findings from this pass push further in the same direction: (a) the
support-table-vs-issue-tracker gap now has two instances, not one, so the "our features are all
in the green column" argument for vinext is worth less than it reads; and (b) the only genuinely
hard runtime constraint we found — Ed25519 raw-key import failing in workerd (G12) — is
framework-independent, which means the Next.js path adds risk without absorbing any. Build the
Vite SPA. Escalate to the user only to amend the spec line, not to decide it.
