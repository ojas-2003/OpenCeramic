# Step 8 — API routes

**Verify:** `vitest run` 166 passed · `tsc --noEmit` exit 0 · full create → column → rows → run → poll flow works from `curl`

## The milestone

This is the first step where the engine runs end to end through Postgres and
Inngest rather than through test doubles. From the terminal:

```
POST /api/tables                     -> table
POST /api/tables/:id/columns         -> input column "Website"
POST /api/tables/:id/columns         -> enrichment column (kitchenSink, domain <- Website)
POST /api/tables/:id/rows            -> 2 rows
POST /api/tables/:id/runs            -> { levels, counts, estimatedCredits: 4 }
GET  /api/runs/:id                   -> status done, 2/2 cells done
```

The run finalised with **estimated 4 / actual 4 credits**, and each cell carried
real provenance:

```json
{"credits":2,"cache_hit":false,"latency_ms":282,"api_call_id":"76caec66-..."}
```

A forced re-run then planned **0 credits, 2 cached**, executed with
`cache_hits: 2` and `actual_credits: 0` — the cache path proven against the
database rather than a stub.

## Routes

| Method | Path | Notes |
|---|---|---|
| `POST`/`GET` | `/api/tables` | |
| `GET`/`DELETE` | `/api/tables/:id` | GET returns table, columns, rows and a flat cell array |
| `POST` | `/api/tables/:id/columns` | Input **or** enrichment columns; full validation |
| `PATCH`/`DELETE` | `/api/columns/:id` | Re-validates on remap |
| `POST` | `/api/tables/:id/rows` | Done cells for input columns, idle for enrichment |
| `POST` | `/api/tables/:id/runs` | Plans, triggers, supports `dry_run` |
| `POST` | `/api/tables/:id/cells/:rowId/:columnId/run` | Cell-scoped shorthand |
| `GET` | `/api/runs/:id?since=` | The polling endpoint |
| `POST` | `/api/runs/:id/cancel` | |
| `GET` | `/api/enrichments` | Registry metadata for the picker |
| `GET` | `/api/account` | Credits and rate limits, 60s in-memory cache |

Every body is validated with Zod and every error returns
`{ error: { code, message, details? } }`.

## Design decisions

### Column validation is a pure function

`src/lib/validateColumn.ts` takes the table entity, the existing columns, the
adapter and the proposed config, and returns an error or null. The route loads
the pieces and calls it.

That is what lets `tests/api/columns.test.ts` cover all sixteen cases with **no
database and no HTTP server**. The route is a shell.

### Required inputs are derived from the Zod schema, not hardcoded

`adapterInputKeys` reads `adapter.inputs.shape` and marks a key required when
`schema.safeParse(undefined)` fails. So:

- `fiber.company.revenue` requires `linkedin_url`
- `fiber.people.findAtCompany` requires `company_linkedin_url` but **not**
  `title_query`, which has a default
- `fiber.company.kitchenSink` requires neither `domain` nor `name` individually,
  because it takes either

That last case needed a special rule: an adapter whose inputs are all optional
still needs **at least one** mapping, or the column can never produce anything.

The same function feeds `GET /api/enrichments`, so the add-column picker in
Step 10 gets required/optional for free rather than duplicating the logic.

### `dry_run` reuses the planner by swapping the writers

Step 10 needs a plan-and-price call that persists nothing. Because Step 5 moved
all persistence to the end of `planRun`, `dry_run` is just dependency injection:
the route passes no-op `upsertCells` and `createRun`. No second code path, and
the estimate is computed by exactly the code that a real run uses.

### `/api/account` degrades instead of failing

Both `getOrgCredits` and `getRateLimits` return **501** on a sandbox key. A
missing balance must not take down the page, so failures become `null` with the
reason attached:

```json
{"credits":null,"rate_limits":null,
 "unavailable":{"credits":"not_implemented: Sandbox mode is not yet available..."}}
```

Results are cached in memory for 60 seconds.

### `PlanError` maps to meaningful status codes

`over_budget` → **409** with `estimatedCredits` and `max` in details, so the UI
can show the numbers. `table_not_found` → 404. Everything else (`cycle`,
`unknown_enrichment`, `unknown_column`) → 400.

## Addition beyond the step's list

**Input columns.** The step specifies `POST /api/tables/:id/columns` for
enrichment columns only, and rows keyed by column *name*. With no way to create
an input column, a table could never be seeded through the API and none of the
downstream routes could be exercised. The route now accepts
`{ kind: "input", name }` alongside the enrichment form. Step 11's CSV import
needs the same thing.

## What the end-to-end run exposed

Chaining one enrichment into another **does not work yet**, and this is the gap
Step 10 fills.

Adding a revenue column fed by the kitchenSink column planned correctly — two
levels, `[[kitchenSink],[revenue]]` — but both revenue cells failed with
`invalid_input`. The reason: a kitchenSink cell's value is an *object*
(`{name, domain, linkedin_url, ...}`) and `fiber.company.revenue` expects
`linkedin_url` to be a string. Input resolution passes the whole object.

Step 10 changes `config.inputs` values to `"<column_id>.<field_key>"` for
enrichment sources and updates resolution to read the field. Until then only
input-column → enrichment mappings resolve, which is what the demo chain's first
level uses.

The run correctly reported `status: failed` because *every* cell in it failed —
partial failure would have been `done`.

## Verified by curl

| Case | Result |
|---|---|
| unmapped required input | 400 `unmapped_input`, names the missing key |
| unknown enrichment | 400 `unknown_enrichment` |
| company adapter on a person table | 400 `entity_mismatch` |
| `?since=` in the future | 0 cells |
| `?since=nonsense` | 400 `invalid_since` |
| cancel a finished run | 409 `run_finished` |
| `/api/enrichments` | 6 adapters with modes, entities, per-row credits, input keys |
| `/api/account` second call | `cached: true` |

## Fixtures added

`getOrgCredits` and `getRateLimits` were not in the Step 3 list, but
`/api/account` needs them under `FIBER_FAKE=1` or the header has no balance to
show in Step 9. Both are shaped against the generated types; the credits fixture
reports 4,900 of 10,000 available.
