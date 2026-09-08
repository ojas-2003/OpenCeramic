# Step 12 — README, deploy, final check

**Verify:** `pnpm build` exit 0 · 177 tests · `tsc --noEmit` exit 0 · all four
final checks pass

## Delivered

`README.md` (312 lines) covering the ten sections the guide specifies, plus a
real screenshot at `docs/images/grid.png` rather than a placeholder.

Two additions beyond the brief:

- **Known gaps**, stated plainly — the unvalidated fixtures, the sandbox 501s,
  the untested Inngest wrapper, the demo table duplicating on each click. A
  reviewer will find these; better they read them from us first.
- **A pointer to `docs/steps/`**, which records every decision and every bug.

## Final checks

| Check | Result |
|---|---|
| `pnpm build` | exit 0, 19 routes |
| No `NEXT_PUBLIC_*` variable touches Fiber | clean |
| `.env.example` complete | matches `.env.local` exactly, no missing keys |
| `/api/inngest` reachable | 200, `function_count: 1` |
| `src/engine/**` imports no adapter | clean |

### One check needed a second look

Grepping for `api.fiber.ai` outside `src/fiber/` flagged all six adapters. They
turned out to be **doc-URL comments** citing where each credit cost came from:

```ts
// https://api.fiber.ai/ai-docs/getCompanyRevenue.md — 4 credits per lookup.
```

A narrower grep for `fetch(` and `process.env.FIBER` in `src/enrichments/`
returns nothing: adapters only ever call `ctx.fiber.call()`. The hard rule holds.
Worth recording because the naive check produces a false positive that a future
reader would otherwise have to re-investigate.

### One README claim was wrong

The first draft said "all 34 executor tests". The file has **43**. Corrected
after checking rather than shipping a number that a reviewer running the suite
would immediately see was false. Every other figure in the README —
177 tests, 202 rows rendering as 34 DOM nodes, four DAG levels, six adapters —
was verified against a real run.

## Deployment

Written but **not executed**: deploying needs the repository pushed to a Git
host and a Vercel account, both of which are the author's to do. The README
gives the exact steps and the environment variables, with a warning not to carry
`INNGEST_DEV` or `FIBER_FAKE=1` into production.

The live URL placeholder stays until that happens.

## Where the project ended up

Twelve steps, 30 commits. 177 tests that need no database, no network and no
Inngest harness, running in about half a second.

The engine does what the design document set out: a DAG planner that refuses an
over-budget run before writing anything, a durable executor that contains a
cell's failure to that cell, "no data found" as a success, skips that record
their reason, a cache keyed on normalised inputs, and credits reconciled from
`api_calls` rather than guessed.

The one thing it has never done is call the live Fiber API for the operations
that matter, because sandbox keys return 501 for six of the seven. That is the
first thing to fix with a live key, and the README says so.
