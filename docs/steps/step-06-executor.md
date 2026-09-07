# Step 6 — Executor (Inngest function) 🔒

**Verify:** `vitest run` 130 passed · `tsc --noEmit` exit 0 · `execute-run` registered with the Inngest dev server

## Delivered

| File | Purpose |
|---|---|
| `src/engine/process.ts` | The pure core: `resolveCells`, `processChunk`, `processBatchChunk`, `processAsyncCell`, `countCells` |
| `src/engine/executor.ts` | The Inngest function — load, dispatch, write, finalise |
| `src/engine/cache.ts` | `getMany`/`set`, expiry-aware, plus `MemoryCache` for tests |
| `src/engine/errors.ts` | `toAdapterError` |
| `src/engine/trigger.ts` | `triggerRun`, `cancelRun` |
| `tests/engine/executor.test.ts` | 33 tests, none of which need a database |

Registration confirmed against the dev server:

```json
{"name":"openceramic","connected":true,"functionCount":1,
 "functions":[{"name":"execute-run","slug":"openceramic-execute-run"}]}
```

## Design decisions

### The logic is in a separate file from the Inngest function

`src/engine/process.ts` knows nothing about Inngest or the database. It takes
work items plus dependencies and returns outcomes. `executor.ts` loads cells,
calls into it, writes results and finalises.

The guide asks that `processChunk` be "a pure function you could read in
isolation"; a separate module makes that literally true, and it is why all 33
tests run with no database and no Inngest test harness.

### One implementation of the async poll loop, not two

`processAsyncCell` takes `runStep` and `wait` as dependencies. In production
they are `step.run` and `step.sleep`, so every `start` and every `poll` is a
durable step and a poll loop survives a redeploy. In tests they default to a
direct call and a no-op, so the same code is exercised without a 5-second wait
per poll.

The alternative — a loop in the Inngest function plus a parallel one for tests —
would mean the tested code is not the code that runs.

### Provenance is captured by wrapping the client

An adapter returns only its output, so the credits and `api_call_id` from its
Fiber call would be lost. `processChunk` hands the adapter a recording proxy
around the `FiberClient` that accumulates both, which is what fills
`provenance.credits` and `provenance.api_call_id`.

This is also what makes run finalisation honest: `actual_credits` sums the
`api_calls` rows the cells point at, deduplicated by id, rather than adding up
provenance numbers — a cell written twice would otherwise be counted twice.

### A null result is cached

"No data found" is a successful `done` with `value = null` (CLAUDE.md). It is
written to the cache like any other result, so a re-run does not pay again to
rediscover the same absence.

### Failure containment

One cell's error never escapes its chunk. Everything an adapter throws is
converted by `toAdapterError` and recorded on that cell; the rest of the chunk
continues. The only thing allowed to propagate out of a step is an
infrastructure failure — the cache or the database being unreachable — because
that is the only case where Inngest retrying the whole step is the right answer.

`toAdapterError` treats an unrecognised error as **terminal**. An error we
cannot classify is not one we can argue is worth retrying three times.

### Skips carry a reason

A cell whose source is failed, skipped, missing or empty becomes `skipped` with
`provenance.skipped_because = { column_id, reason }`, where reason is one of
"source column failed", "source column was skipped", "source column has not
run", "source value is empty", "source cell has not been created". The user sees
*why* a cell is blank rather than a silent gap.

### Chunk sizes

Sync work is chunked at 10 cells per step and batch work at the adapter's
`batchSize` (default 25). Inngest caps steps per run; one step per cell would
exhaust it on a 200-row by 4-column table. Within a sync chunk, cells run under
a semaphore of `adapter.concurrency ?? 5`.

## Deviations

### `mapWithConcurrency` instead of `p-limit`

The guide names p-limit. The semaphore is twelve lines and `p-limit` was not
among the Step 1 dependencies, so it is written locally rather than adding a
package. Behaviour is the same: bounded concurrency, results in input order —
both asserted by tests.

### `countCells` lives in `process.ts`

It was first written in `executor.ts`, which made the test file import the
database client transitively and fail with "DATABASE_URL is not set". Rather
than give the tests a database, the pure function moved to the pure module —
exactly the refactor the guide's recovery prompt prescribes. `executor.ts`
re-exports it.

### Inngest 4 API shape

The guide's `createFunction(config, trigger, handler)` is the v3 signature. v4
takes two arguments with the trigger inside the options object:

```ts
inngest.createFunction(
  { id: "execute-run", triggers: [{ event: "run/requested" }], retries: 2,
    concurrency: { limit: 3 },
    cancelOn: [{ event: "run/cancelled", if: "event.data.runId == async.data.runId" }] },
  async ({ event, step, logger }) => { ... },
);
```

## A bug the tests caught

`processBatchChunk` treated a missing entry from `runBatch` as a legitimate
`null` result, marking the cell `done` with an empty value. `runBatch` declares
`Array<O | null | AdapterError>`: a short array or an `undefined` slot means the
adapter gave that cell **no answer**, which is not the same as answering
"nothing found". Those cells now fail with `batch_result_missing`.

Without the test this would have shown up as silently blank cells in the demo
rather than as an error.

## Test coverage

Every case the guide asked for, plus the boundaries around them:

| Case | Result |
|---|---|
| cache hit | no Fiber call, `provenance.cache_hit = true` |
| failed upstream | downstream `skipped` with the reason recorded |
| retryable twice then success | `done`, 3 api_calls logged (429, 429, 200) |
| terminal error | `failed`, one attempt, no retry |
| persistently retryable | `failed` after exactly 3 attempts |
| null result | `done` with `value = null`, and cached |
| batch positional mapping | mid-array `AdapterError` fails only its own cell |
| async pending, pending, done | `done` |
| async pending x 24 | `failed` with `poll_timeout` |
| concurrency limit | peak in-flight never exceeds `adapter.concurrency` |

## Not yet exercised

The Inngest wrapper itself has no automated test — the 33 tests cover the pure
core. The wrapper is thin (load, dispatch, write, finalise) and is verified only
by the dev server accepting its registration. A real end-to-end run needs the
API routes from Step 8; until then nothing has driven a run through Postgres.
