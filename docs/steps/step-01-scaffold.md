# Step 1 — Scaffold

**Commits:** `59b5b84` (scaffold), `75e44cf` (Docker + Vitest)
**Verify:** `pnpm typecheck` clean · `pnpm test` green · `/` renders · `/api/inngest` returns `function_count: 0`

## Delivered

Next.js 15.5.25 (App Router, TypeScript strict, Tailwind 4, `src/`), the full
dependency set, shadcn/ui with nine components, the npm scripts, and four
scaffold files:

| File | Purpose |
|---|---|
| `src/db/client.ts` | Drizzle over `neon-http`, throws if `DATABASE_URL` is unset |
| `src/inngest/client.ts` | `new Inngest({ id: "openceramic" })` |
| `src/app/api/inngest/route.ts` | Serve endpoint, empty functions array |
| `vitest.config.mts` | `@/` → `src/` alias |

`src/fiber/types.generated.ts` — 9.3 MB, 156,273 lines — generated from
`https://api.fiber.ai/openapi.json`. All ten operations the project needs are
present.

## Design decisions

### Generated Fiber types are committed

The alternative is generating them at build time, which is smaller in the
repository but makes `pnpm build` depend on Fiber's availability and on the spec
not shifting between builds. Committing them makes the build hermetic and makes
spec drift show up as a reviewable diff. The cost is a heavy clone.

*Revisit if:* the repository size becomes a problem for reviewers.

### Next.js runs on the host, only Inngest runs in Docker

`pnpm dev` keeps fast hot reload; the Inngest dev server is a fixed binary with
no reason to live outside a container. The container reaches the app through
`host.docker.internal:3000`, verified by the dev server discovering the app as
`openceramic`.

The database stays on Neon rather than a local Postgres, so `drizzle-orm/neon-http`
is exercised in development exactly as it runs in production. Running Postgres
locally would have required a Neon HTTP proxy container to keep the same driver.

### shadcn's default preset, not a chosen base colour

shadcn 4 removed `--base-color`; base colour now comes from a preset. The default
(`base-nova`) already resolves to `"baseColor": "neutral"`, which is what the
guide asked for, so no migration was needed.

Two things about shadcn 4 differ from what `docs/DESIGN.md` assumes and will
matter when writing UI in Steps 9–10:

- components are built on **Base UI**, not Radix
- `cn` is its own package, not `clsx` + `tailwind-merge`

The `shadcn` CLI was moved from `dependencies` to `devDependencies` — nothing in
`src/` imports it.

## Deviations

### `vitest.config.ts` → `vitest.config.mts`

Vitest loads a `.ts` config as CommonJS, which then `require()`s an ESM-only
dependency. Node 22.1.0 does not support `require(esm)` — that arrived in 22.12+.
The `.mts` extension forces ESM and the problem disappears. `**/*.mts` was added
to the tsconfig `include` so the file is still typechecked.

`next.config.ts` has the same shape of exposure: Next shells out to TypeScript to
read it, which is how a corrupted `typescript` install (below) surfaced as a
config-loading crash. Renaming it to `next.config.mjs` would remove that
dependency permanently. Left as-is pending a decision.

### `INNGEST_DEV=1` added to `.env.example`

Inngest 4 defaults to cloud mode and returns 500 from `/api/inngest` without a
signing key. Without this variable `pnpm dev` is broken out of the box, so the
strictly-verbatim env list was not worth preserving. Commented as dev-only.

### `inngest:dev` runs Docker

The guide's `npx inngest-cli@latest dev` re-resolves `@latest` and downloads a
~90 MB Go binary into a throwaway cache on every invocation, with no progress
output — it reads as a hang. `docker compose up inngest` caches the image layer.

### Vitest 4 rather than 5

Chosen while fighting a native-binding failure. Vitest 5 is the first release
built on rolldown, and downgrading to 4 was an attempt to avoid it — which did
not work, because Vite 8 is rolldown-based too. The real fix was elsewhere (see
below). Vitest 4 was kept because it is the more settled line and nothing in the
test plan needs 5.

## Environment notes

These cost real time and will recur on this machine.

### The disk is nearly full

The data volume is at **98%, ~4.3 GiB free**. This is the most likely root cause
of the corruption below and is worth clearing before the deploy steps.

### pnpm had to be installed via npm

Corepack bundled with Node 22.1.0 fails with `Cannot find matching keyid` — a
stale npm registry signing key. Installed instead with
`npm install -g --prefix ~/.local pnpm`, which uses ordinary registry integrity
checks rather than disabling signature verification.

### `pnpm install --force` corrupted `node_modules`

Run to recover one missing optional binary, it refetched ~1000 packages over a
throttling connection and wrote truncated files. `typescript/lib/typescript.js`
ended up 9.1 MB of nothing, so `require("typescript")` returned `{}` and Next
could not load `next.config.ts`. A clean `rm -rf node_modules && pnpm install`
fixed it.

**Lesson:** `--force` is not a targeted fix. It is safe only once the store is
already populated, where it relinks without downloading.

### pnpm silently skips rolldown's native binding

`@rolldown/binding-darwin-arm64` declares `os` and `cpu` as **strings**, where
the npm specification says arrays. pnpm 12's architecture filter mishandles that
and skips the package with no error — install "succeeds", then Vitest cannot
start. Neither `supportedArchitectures` nor adding it to `optionalDependencies`
helped; only `--force` relinks it.

It is now in the lockfile and store, so ordinary `pnpm install` works. If it is
ever lost again, the fix is:

```
pnpm install --force --prefer-offline
```

### `create-next-app` rejected the directory

`OpenCeramic` contains capitals, which npm rejects as a package name. Scaffolded
out-of-tree into a directory named `openceramic` and rsynced in. `package.json`
carries the lowercase name.

## Deliberately not done

The tooltip install printed a reminder to wrap the root layout in
`TooltipProvider`. That belongs to Step 9, so `src/app/layout.tsx` was left
alone.
