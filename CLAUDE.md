# OpenCeramic

Open-source Clay-style enrichment spreadsheet built exclusively on Fiber AI APIs.
Full design: docs/DESIGN.md — read it before any change to the engine, planner, schema or enrichment interface.

## Stack (do not substitute)
- Next.js 15 App Router, TypeScript strict, pnpm
- Postgres on Neon, Drizzle ORM (drizzle-orm/neon-http), drizzle-kit migrations
- Inngest for durable execution (inngest + inngest/next)
- TanStack Table + TanStack Query, shadcn/ui, Tailwind
- Zod for all validation, Vitest for tests
- Types for Fiber generated from https://api.fiber.ai/openapi.json via openapi-typescript

## Architecture in one paragraph
A table has rows and columns. Enrichment columns declare inputs mapped to other columns,
forming a DAG. A run is planned synchronously (topological sort → cell statuses → credit
estimate) and executed by an Inngest function that walks the DAG level by level, dispatching
cells to enrichment adapters in chunks, with caching, retries, and partial-failure semantics.
Cells are the job records; there is no separate jobs table.

## Hard rules
- The engine (src/engine/**) never imports a specific adapter. Adapters register through src/enrichments/registry.ts.
- Every Fiber call goes through src/fiber/client.ts. Never call fetch("https://api.fiber.ai") anywhere else.
- FIBER_API_KEY is server-only. Never expose it to client components or NEXT_PUBLIC_* vars.
- Every cell write is an upsert on (row_id, column_id). Never insert cells without ON CONFLICT.
- "No data found" from Fiber is a successful null value (status=done, value=null), not a failure.
- Do not add features not asked for in the current step. Do not refactor files outside the step's scope.
- After each step: pnpm typecheck && pnpm test must pass. Report what you changed and anything you were unsure about.

## Layout
src/app/            Next.js routes (app/api/** are route handlers)
src/db/             schema.ts, client.ts, migrations
src/fiber/          client.ts, types.generated.ts, fake.ts, fixtures/
src/enrichments/    types.ts, registry.ts, one file per adapter
src/engine/         planner.ts, executor.ts (Inngest fn), cache.ts, errors.ts
src/inngest/        client.ts
src/components/     UI
src/lib/            shared helpers
tests/              vitest, mirrors src/
