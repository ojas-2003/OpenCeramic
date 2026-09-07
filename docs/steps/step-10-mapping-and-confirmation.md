# Step 10 — Add column, run confirmation, cell mapping

**Verify:** 176 tests pass · `pnpm build` succeeds · a chained column now resolves end to end

## The headline: chaining works

Since Step 8 an enrichment column fed by another enrichment column failed on
every row with `invalid_input`. A kitchenSink cell's value is a JSON *object*;
`fiber.company.revenue` wants a `linkedin_url` string. Input resolution handed
over the whole object.

`config.inputs` values now carry the field:

```
"col-website"                 an input column, whole value
"col-company.linkedin_url"    an enrichment column, one field
```

Verified against Postgres with a real run:

```
levels : [[Resolve company], [Company revenue]]
status : done
counts : {"done": 4, "total": 4, "failed": 0, "skipped": 0, "cache_hits": 2}
```

The revenue column that was solid red in the Step 9 screenshot now shows real
values.

## Delivered

| File | Purpose |
|---|---|
| `src/engine/sourceRef.ts` | `parseSourceRef`, `readSourceValue` — the dotted form |
| `src/components/grid/AddColumnDialog.tsx` | Pick → map → name |
| `src/components/grid/RunConfirmDialog.tsx` | Prices a run before it happens |
| `src/components/grid/sourceOptions.ts` | Which columns may feed which input |

## Design decisions

### One resolver, used by both planner and executor

`readSourceValue` is the single place that decides whether a source cell can
feed a dependent. The planner uses it to decide whether a cell is priceable
against the cache; the executor uses it to decide whether a cell runs or skips.
Two implementations would eventually disagree about what "empty" means, and the
symptom would be an estimate that does not match what runs.

The dotted form splits on the **first** dot, so a field key may itself contain
dots.

An empty string is treated as empty, like null. A cell whose named field is
blank skips with `source field "linkedin_url" is empty` rather than passing `""`
into an adapter that would reject it as `invalid_input`. Skipping states the
cause; failing states a symptom.

### Edges point at the column, not the field

`edgesFromColumns` strips the field before building the DAG, so
`col-a.x` and `col-a.y` are one edge. The field is a value selector, not a graph
node — otherwise topological sorting would see phantom nodes that no column
corresponds to.

### The picker is derived from the schemas

`adapterInputKeys` now probes each input for what it accepts (`safeParse("probe")`,
`safeParse(1)`, `safeParse(true)`), and `sourceOptionsFor` offers:

- **input columns** to any input accepting a string
- **each compatible output field** of an enrichment column, separately

So mapping `linkedin_url` offers "Resolve company → LinkedIn URL" rather than
"Resolve company", and picking it writes the dotted value. Nothing about types
is hardcoded per adapter, so a new adapter's picker is correct the day it lands.

### `dry_run` prices a run before anything is spent

`RunConfirmDialog` plans with `dry_run: true`, which persists nothing, and shows
"Run N cells (M cached) · est. X credits · balance Y". Confirm issues the real
call. Over budget renders the numbers and names `MAX_CREDITS_PER_RUN`.

Every path — Run table, Run column, Force re-run, Re-run cell — goes through it.

## An inconsistency the end-to-end run exposed

The first chained run reported **est 8 / actual 2**. The adapters estimate from
the documented per-operation prices, but three fixtures carried different
`creditsCharged` values invented back in Step 3:

| Operation | Documented | Fixture said |
|---|---|---|
| `getCompanyRevenue` | 4 | 1 |
| `socialMediaLookupTrigger` | 6 (3 × 2 platforms) | 2 |
| `pollBatchContactDetails` | 5 | 3 |

All three are corrected, and a test now asserts every adapter's
`estimateCredits` equals the `creditsCharged` in the fixture that bills it — so
this cannot drift again.

### Estimates over-state on purpose

A later run showed **est 6 / actual 2**, which is *correct*. A cell whose
upstream has not run yet cannot be priced against the cache, so the planner
counts it as a miss (DESIGN.md §4.2). Here the revenue cell turned out to be a
cache hit at execution time. The estimate is an upper bound; a user is never
surprised by a bill larger than the one they approved.

## Placeholders replaced

Rename and delete still use `window.prompt`/`confirm`. Adding a column is now a
real dialog; editing an existing column's mapping is not, which is the one part
of the step's "Edit" item left undone.
