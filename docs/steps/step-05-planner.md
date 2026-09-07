# Step 5 — Planner 🔒

**Verify:** `vitest run` 97 passed · `tsc --noEmit` exit 0

Locked contract: `PlanInput`, `PlanResult` and the `planRun` signature are the
guide's, unchanged.

## Delivered

| File | Purpose |
|---|---|
| `src/engine/planner.ts` | `planRun`, plus `topoSortLevels`, `downstreamOf`, `edgesFromColumns` as pure functions |
| `src/db/queries.ts` | `createRun` added — the planner inserts the run row |
| `tests/engine/planner.test.ts` | 26 tests: 15 pure-graph, 11 against an in-memory stub of the queries module |

## Design decisions

### The budget check happens before anything is written

The guide's algorithm upserts cells at step 5, throws `over_budget` at step 7,
and inserts the run at step 8. Taken literally that leaves **orphaned `pending`
cells pointing at a run that was never created** whenever a plan is refused.

`planRun` computes the whole plan in memory, prices it, checks the budget, and
only then writes. A refused plan leaves no trace — asserted by two tests that
check `upsertCells` and `createRun` were never called after `over_budget` and
after `cycle`.

This also makes Step 10's `dry_run=true` nearly free: computation is already
separate from persistence.

### Edges touching columns outside the run are ignored

An enrichment column's inputs usually come from an input column, which is never
part of a run. Counting that edge would leave the dependent stuck at in-degree 1
and it would never schedule. `topoSortLevels` filters to edges whose *both* ends
are in the node set.

This is what makes `scope=column` work at all: running column B alone must not
require A to have been included.

### Re-planning preserves the previous value

The guide says "clear error fields". `planRun` clears `error_code`,
`error_message` and `provenance` — provenance describes a previous run, so it
must go — but keeps `value`.

A re-run that fails should not destroy a good result the user already had. The
value is overwritten on success anyway.

### Levels are deterministic

Kahn's frontier is filtered through the incoming `nodes` order rather than
emitted in discovery order, and `getTableWithData` returns columns ordered by
position. So the same table always plans to the same `levels`, which makes the
plan diffable and the tests exact rather than order-insensitive.

Duplicate edges are de-duplicated before counting in-degree; a repeated
`config.inputs` mapping would otherwise leave a column permanently unschedulable.

### Failures are loud and early

`planRun` throws before any write for: a cycle, an unknown column in `target`, a
column whose adapter is not registered, and a missing table. A column pointing
at an unregistered adapter is a misconfiguration that would otherwise surface as
a failed cell mid-run.

## Cache pricing

Only cells whose inputs resolve *right now* can be priced against the cache. A
cell whose upstream is itself pending has no resolvable input, so it cannot have
a cache key and is assumed to be a miss — as the guide specifies.

Resolvable inputs are validated with the adapter's own `inputs` schema before
`cacheKey` is called, so a malformed upstream value degrades to "assume a miss"
rather than throwing inside the planner.

One `cacheLookup` call covers the entire run; a test asserts it is called
exactly once.

## Live API findings (sandbox key)

A sandbox key (`sk_test_…`) was available at this point, so the Fiber layer was
exercised against the real API for the first time. Sandbox keys **never charge
credits**, so this cost nothing.

**Sandbox coverage is far narrower than this step first concluded.** The initial
probe used incomplete request bodies, and Fiber validates the body *before*
checking sandbox availability — so several endpoints answered `400 body/x
Required` and looked reachable.

Re-probed with valid bodies (Step 12), **only `/v1/people-search` works**. Every
other operation returns `501 Sandbox mode is not yet available for this
endpoint`, including `kitchenSinkCompany`, `getCompanyRevenue`,
`emailBounceDetection`, `startBatchContactDetails`, `socialMediaLookupTrigger`,
`getOrgCredits` and `getRateLimits`.

Three consequences:

1. **A 501 was being treated as retryable.** The error taxonomy mapped all 5xx
   to retryable, so every sandbox-unsupported call would burn three attempts
   with backoff for something that can never succeed. 501 and 505 are now
   terminal, with code `not_implemented`.

2. **The `peopleSearch` fixture had invented field names.** It used `full_name`,
   `linkedin_url` and `location_name`; the API returns `name`, `url` and
   `locality`. The fixture is now the **recorded live response**, and a test
   asserts the real names. This matters directly for the Step 7
   `fiber.people.findAtCompany` adapter.

   Worth noting *why* the compile-time check missed it: `satisfies` catches
   missing required fields and wrong types, but every field in these responses
   is optional, and excess-property checking does not apply to values imported
   from JSON. Invented optional fields pass. Recording real responses is the
   only reliable defence.

3. **`GET /api/account` (Step 8) cannot work on a sandbox key** — both
   `getOrgCredits` and `getRateLimits` return 501. That route will need to
   degrade gracefully rather than error.

`kitchenSinkCompany` — the Step 4 adapter and the head of the demo chain — is
**not** verifiable against sandbox. Its fixture remains unvalidated against a
real response.

## Environment — the real cause of the slow toolchain

The project lives in `~/Desktop`, and **iCloud "Desktop & Documents" sync is
enabled**. Every file operation, including all of `node_modules`, goes through
the macOS file-provider daemon.

Measured: `tsc --noEmit` against a **97-byte stub** in place of the generated
types still took **5 minutes 27 seconds**, using 1.29 s of CPU. The generated
types file is not the cause — tsc is blocked on thousands of file stats.

This single cause explains the whole history of odd behaviour: `grep`/`head`/
`sed` returning empty on a large file (unmaterialised placeholder), the same
test suite taking 261 ms and then 70 s, npm tarballs silently truncating in
Step 1, and `pnpm install --force` corrupting `typescript.js`.

**Recommended fix: move the repository outside `~/Desktop`** (for example
`~/dev/OpenCeramic`) and reinstall `node_modules`. Nothing in the project needs
to change.
