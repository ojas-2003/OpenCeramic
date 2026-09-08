# Step 11 — Import, export, demo seed, polish

**Verify:** 177 tests · `pnpm build` succeeds · the demo table runs the full
six-column chain end to end

## The demo runs

`POST /api/demo` builds the table from DESIGN.md §5.1 — 25 real SaaS domains,
eight columns, four DAG levels, all three run modes:

```
Website -> Resolve company -> Revenue
                           -> Talent flow
                           -> Find CEO -> Reveal contact -> Validate email
                                                        -> Social handles
```

Planned as `levels: [1, 2, 2, 1]` — four deep, exactly as designed. 150
enrichment cells, 473 credits estimated.

Final state: **150 done, 25 skipped, 0 failed.**

The 25 skips are the failure semantics working. `Reveal contact` legitimately
returned `null` for these profiles, so `Validate email` skipped with
`source value is empty` naming its source column, rather than failing on a null
email or leaving a silent blank.

## Delivered

| File | Purpose |
|---|---|
| `src/db/seed.ts` | The demo table; also `pnpm db:seed` |
| `src/app/api/demo/route.ts` | "Load demo table" |
| `src/app/api/tables/[id]/export/route.ts` | CSV export |
| `src/app/api/cache/route.ts` | Cache stats and clear |
| `src/app/settings/page.tsx` | Credits, rate limits, cache, run budget |
| `src/components/grid/ImportCsvDialog.tsx` | Client-side parse, batched upload |
| `src/components/Toaster.tsx` | Toast context used by every mutation |

## Design decisions

### Export flattens to scalars

Input columns keep their name. Each enrichment column becomes one CSV column per
output field, headed `<column>.<field>` — `Resolve company.linkedin_url`,
`Revenue.range_low`. A spreadsheet gets values, not JSON blobs. Cells containing
quotes, commas or newlines are quoted and escaped.

### Import parses in the browser and uploads in batches

papaparse runs client-side, so a large file never becomes one enormous request.
Headers the table does not already have become input columns; rows post 200 at a
time. The dialog shows the header mapping before anything is written.

### The seed uses the dotted form throughout

Every enrichment column past the first maps to a *field* of its source
(`<column_id>.linkedin_url`), which is what Step 10 introduced. The seed is
therefore also a regression test for chained resolution: if that broke, the demo
would fail visibly on first run.

### Toasts rather than a dependency

A ~60-line context with a `notify`/`fail` pair, wired into every mutation. Not
worth adding a toast library for.

## A bug the demo run caught

The first full run completed three levels (75 cells) and then the **batch**
adapter crashed:

```
NeonDbError: invalid input syntax for type integer: "0.2"
```

`processBatchChunk` spreads a batch's credits evenly across its cells for
per-cell provenance — `1 credit ÷ 5 cells = 0.2` — and `enrichment_cache.credits`
is an `integer` column. The float is fine in `provenance` (jsonb) but not there.

Fixed by rounding the share before the cache write. The run's `actual_credits` is
summed from `api_calls`, not from these values, so nothing about reconciliation
changes. A regression test now asserts every value written to the cache is an
integer.

**Only a run of this shape would have found it.** Every earlier test used a
one-cell batch, where the division is exact.

### And the engine handled it correctly

The crash is also evidence the failure semantics work. Three completed levels
stayed `done`; the remaining 75 cells stayed `pending`. Re-running after the fix
planned **exactly those 75 cells** and left the finished 75 untouched — the
resumability DESIGN.md §4.3 claims, demonstrated rather than asserted:

```
cells to run: 75    (of 150)
est credits : 300
```

## Note on the fake data

Under `FIBER_FAKE=1` every row resolves to the same fixture, so the demo shows
25 identical Stripe rows. That is the fake client being deterministic, not a bug
in the chain. With a live key each row resolves independently.

This is also why `Reveal contact` is null for every row: the recorded
`peopleSearch` fixture returns `jane-doe-sandbox`, which the contact fixture has
no entry for.
