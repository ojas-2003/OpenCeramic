# Step 9 — Grid UI

**Verify:** `pnpm build` succeeds · 166 tests pass · page renders 202 rows with 34 row elements in the DOM

## Delivered

| File | Purpose |
|---|---|
| `src/app/page.tsx` | Table list plus a "New table" dialog |
| `src/app/tables/[id]/page.tsx` | The table page |
| `src/components/grid/Grid.tsx` | Virtualized grid |
| `src/components/grid/CellChip.tsx` | Status icon plus one-line value summary |
| `src/components/grid/CellSheet.tsx` | Value, provenance, error, re-run |
| `src/components/grid/ColumnMenu.tsx` | Run · Force re-run · Rename · Delete |
| `src/components/grid/TableHeader.tsx` | Name, entity, credits, Run table, progress bar |
| `src/components/grid/useTableRun.ts` | Run polling and start-run mutation |
| `src/lib/apiClient.ts`, `src/lib/types.ts` | Typed fetch layer |
| `src/app/providers.tsx` | QueryClient and TooltipProvider |

Every component is under 150 lines.

## Verified in a real browser

Headless Chrome against the dev server, on a table with 202 rows:

- Header reads `Demo · company · 202 rows · 4,900 credits · Run table`
- Column headers show the enrichment label above its source hint —
  `Resolve company / ← Website`, `Company revenue / ← Resolve company`
- Chips render per status: green check with the resolved LinkedIn URL, red
  cross with `invalid_input`, grey dot for idle
- **34 row elements in the DOM for 202 rows**, and `company199.com` is absent
  entirely — virtualization is real, not assumed

## Design decisions

### Polling patches the cache; it does not refetch the table

`useRunPolling` calls `GET /api/runs/:id?since=` every 1.5s and merges the
returned cells into the cached `TablePayload` with `setQueryData`. Refetching
the whole table on a timer would re-render all 202 rows and fight the user's
scroll position, for a payload that is almost entirely unchanged.

The `since` cursor advances after each poll, so each request asks only for what
changed. `refetchInterval` returns `false` once the run reaches a terminal
status, which stops the loop without an effect or a timer to clean up.

One full invalidation fires when the run settles, to pick up anything the diff
window missed.

### The chip summary follows the adapter's declared field order

`summarise()` walks `outputFields` in the order the adapter declares them and
shows the first non-null value, rather than `Object.keys()` order. So a column
shows the same field on every row instead of whichever key happened to be
populated first.

Failed cells show the error code; skipped cells show the skip reason, which is
the whole point of recording it.

### Cells are buttons

Each cell is a real `<button>`, so the grid is keyboard-navigable and
focus-visible without adding key handlers to a `div`.

## What the screenshot shows that is not finished

The `Company revenue` column is red `invalid_input` on every row. That is the
chaining gap from Step 8: a kitchenSink cell's value is an object, and the
revenue adapter wants a string field out of it. **Step 10 fixes this** with the
dotted `<column_id>.<field_key>` mapping.

It is worth seeing in the UI, because it is exactly what a reviewer would hit
first, and the failure is legible rather than silent.

## Deferred to Step 10, per the guide

No add-column dialog and no run-confirmation dialog. "Run table" posts directly.
Rename uses `window.prompt` and delete uses `window.confirm` — placeholders
until the dialogs land.

## A bug `pnpm build` caught that nothing else did

`src/app/api/tables/route.ts` ended with a stray `export { apiError };`. Next
route files may only export HTTP method handlers and a few config fields, so the
build failed:

```
Type error: Route "src/app/api/tables/route.ts" does not match the required
types of a Next.js Route. "apiError" is not a valid Route export field.
```

Neither `pnpm dev` nor `tsc --noEmit` flags this — the constraint is enforced by
Next's own build-time type generation. This was the first `pnpm build` of the
project, and it closed a risk that had been open since Step 1: a build-only
failure would otherwise have surfaced during the Step 12 deploy.

Build output is clean: 15 routes, table page 41.9 kB / 192 kB first load.

## Note on tooling

`chromium-cli` is not available here and Playwright is not installed, so the
browser check used the Chrome already on the machine via `--headless=new`,
`--screenshot` and `--dump-dom` against an isolated `--user-data-dir`. No driver
was written, so there is nothing worth capturing as a project skill.
