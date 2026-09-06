# Step 2 — Database schema 🔒

**Commit:** `653c94c` · **Verify:** `pnpm db:migrate` applied · `pnpm typecheck` clean

This step is a locked contract. The composite cell key in particular cannot be
changed later without reworking every write path.

## Delivered

| File | Purpose |
|---|---|
| `src/db/schema.ts` | 5 enums, 7 tables, 5 indexes, inferred row types, JSON shape types |
| `src/db/queries.ts` | `getTableWithData`, `upsertCells`, `updateRun`, `getPendingCells` |
| `drizzle.config.ts` | drizzle-kit configuration |
| `src/db/migrations/0000_awesome_mattie_franklin.sql` | The generated migration |

Applied to Neon (PostgreSQL 18.6, database `neondb`).

## Design decisions

### The cell is the job record

There is no jobs table. A cell's primary key is the pair `(row_id, column_id)`,
so every write is an upsert and a redelivered Inngest step is harmless rather
than a double-billing bug. This is the single most consequential choice in the
schema and the reason the executor in Step 6 can be naive about retries.

Verified against the live database rather than the migration file, by querying
`pg_index`:

```
CELLS PK: row_id + column_id
```

### JSON columns are typed at the boundary

`config`, `provenance`, `target`, `plan` and `counts` are `jsonb` with
`.$type<T>()` applied, so `ColumnConfig`, `CellProvenance`, `RunTarget`,
`RunPlan` and `RunCounts` are enforced in TypeScript while the database keeps a
stable schema as adapter output shapes vary. This is what lets a new adapter ship
without a migration.

### `upsertCells` chunks internally

Step 5 mandates that the planner writes an entire run's scope in **one**
`upsertCells` call. At 9 columns per cell, Postgres's 65535 bound-parameter cap
is reached around 7000 cells — reachable on a large table. The function splits
into statements of 500 rows internally, so the mandated signature is unaffected.

### `drizzle.config.ts` loads `.env.local` itself

drizzle-kit runs outside Next.js and would not otherwise see `DATABASE_URL`. It
uses `process.loadEnvFile`, a Node builtin, so no dependency was added, and falls
through to the ambient environment on Vercel and CI.

## Deviation

### `columns.config` defaults to `{"inputs":{}}`, not `{}`

The guide specifies `config jsonb not null default '{}'`. `ColumnConfig` declares
`inputs` as **required**, so a literal `{}` would produce a value whose declared
type lies about it. The planner in Step 5 reads `config.inputs` on every column,
and input columns — which never receive an explicit config — are exactly the rows
that would carry the bare `{}`.

The default now satisfies the declared type. No field was renamed and no shape
changed, so this is revertible by changing one `.default()` call and defending at
each read site instead.

## Verification

Beyond typecheck and a successful migration, the live schema was queried
directly to confirm shape rather than trusting drizzle-kit's output:

- 7 tables, 5 enums in declared order
- 5 indexes: `cells(column_id, status)`, `cells(run_id)`,
  `columns(table_id, position)`, `rows(table_id, position)`, `api_calls(created_at)`
- 5 foreign keys, all `ON DELETE cascade`

Semantics were then checked with a throwaway round-trip script, since a schema
existing is not the same as an upsert behaving. Thirteen assertions passed:

- inserting the same `(row_id, column_id)` twice leaves **one** row with the
  second write's status, value and provenance — no duplicate, no throw
- `getPendingCells` finds a pending cell and stops finding it once done
- `getTableWithData` returns columns ordered by position and `null` for a missing id
- `updateRun` patches status and counts
- deleting a table cascades all the way to cells

The script cleaned up after itself. It is not a Vitest test: `CLAUDE.md` requires
that tests never depend on a database. The pure-function equivalents arrive in
Step 5.

## Note

Migration filenames are drizzle-kit's generated names
(`0000_awesome_mattie_franklin`). Descriptive names would need `--name` on every
`db:generate`.
