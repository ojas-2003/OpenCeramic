# Build log

One document per build step. Each records what the step delivered, the design
decisions taken inside it, anywhere the implementation deviated from
`openceramic-claude-code-guide.md`, and how it was verified.

The guide owns the contracts; these documents own the reasoning.

| Step | Document | Commit | Status |
|---|---|---|---|
| 0 | [Bootstrap](step-00-bootstrap.md) | `1047c33` | done |
| 1 | [Scaffold](step-01-scaffold.md) | `59b5b84`, `75e44cf` | done |
| 2 | [Database schema](step-02-schema.md) 🔒 | `653c94c` | done |
| 3 | [Fiber client + fake client](step-03-fiber-client.md) | `4a7f7b0` | done |
| 4 | [Enrichment interface, registry, first adapter](step-04-enrichment-interface.md) 🔒 | `e9af2f2` | done |
| 5 | [Planner](step-05-planner.md) 🔒 | `0c74d8c` | done |
| 6 | [Executor (Inngest function)](step-06-executor.md) 🔒 | `cdb8e59` | done |
| 7 | [Remaining adapters](step-07-adapters.md) | `8eacec4` | done |
| 8 | [API routes](step-08-api-routes.md) | `9ed4996` | done |
| 9 | Grid UI | — | next |
| 10 | Add column, run confirmation, cell mapping | — | |
| 11 | Import, export, demo seed, polish | — | |
| 12 | README, deploy, final check | — | |

🔒 marks a step whose interfaces are fixed by the guide and must not be reshaped
by later steps.

## Conventions

- **Deviation** — the implementation differs from the guide's literal wording.
  Every one is called out explicitly with its reason, so they can be reverted.
- **Environment note** — something specific to this machine (Node version, disk,
  package manager) rather than to the project. Recorded because several cost
  real time and will recur.

## Running record of deviations

| Step | Deviation | Why |
|---|---|---|
| 1 | `vitest.config.ts` → `vitest.config.mts` | Node 22.1.0 cannot `require()` an ESM dependency through a `.ts` config |
| 1 | `INNGEST_DEV=1` added to `.env.example` | Inngest 4 defaults to cloud mode; `/api/inngest` 500s locally without it |
| 1 | `inngest:dev` runs Docker, not `npx inngest-cli` | `npx …@latest` re-downloaded a ~90 MB binary every invocation |
| 1 | Vitest pinned to 4, not 5 | Chosen for the more settled line after a native-binding fight |
| 2 | `columns.config` defaults to `{"inputs":{}}`, not `{}` | `{}` would violate the declared `ColumnConfig` type at every read site |
| 3 | Fixture type assertions widen literals via `DeepWiden` | TypeScript widens string literals on JSON import; structural checks all retained |
| 4 | `types.generated.ts` → `.d.ts` | `skipLibCheck` only applies to declaration files; cut typecheck CPU from minutes to ~1.3s |
| 4 | `tests/scaffold.test.ts` deleted | Step 1 placeholder; its Inngest SDK import cost 40s per test run and asserted nothing |
| 5 | Budget check moved before all writes | The guide's order leaves orphaned `pending` cells pointing at a run that was never created |
| 5 | Re-planning keeps `value`, clears `provenance` | A failed re-run must not destroy the previous good result |
| 5 | 501/505 are terminal, not retryable | Fiber returns 501 on sandbox keys; retrying burns three attempts for something that can never succeed |
| 6 | Pure logic split into `src/engine/process.ts` | Makes `processChunk` readable in isolation and lets all 33 tests run without a database |
| 6 | `mapWithConcurrency` instead of `p-limit` | Twelve lines versus a new dependency; same bounded concurrency and input ordering |
| 6 | Inngest v4 two-argument `createFunction` | The guide's three-argument form is the v3 signature |
| 7 | `contact.reveal` batchSize 25, not Fiber's documented 2000 | runBatch must start and finish inside one Inngest step with a 60s poll budget |
| 8 | Input-column creation added to the columns route | Without it a table cannot be seeded through the API, so no other route can be exercised |
