# Step 4 — Enrichment interface, registry, first adapter 🔒

**Verify:** `pnpm test` 69 passed · `tsc --noEmit` exit 0

Locked contract. `src/enrichments/types.ts` is copied verbatim from the build
guide; later steps adapt to it rather than reshaping it.

## Delivered

| File | Lines | Purpose |
|---|---|---|
| `src/enrichments/types.ts` | 56 | The interface, verbatim |
| `src/enrichments/normalize.ts` | 49 | `normalizeDomain`, `normalizeUrl`, `normalizeEmail` |
| `src/enrichments/registry.ts` | 82 | `register`, `get`, `list`, `listForEntity` |
| `src/enrichments/fiber.company.kitchenSink.ts` | 95 | First adapter, mode `sync` |
| `src/enrichments/index.ts` | 30 | The only module that imports adapters |

Tests: `tests/enrichments/contract.test.ts`, `tests/enrichments/kitchenSink.test.ts`.

## Design decisions

### Mode/method mismatches are a startup crash

`register()` validates that a `sync` adapter implements `run` and *only* `run`,
`batch` implements `runBatch`, and `async` implements both `start` and `poll`.
Implementing an extra method is rejected too — a mode maps to exactly one
execution path, and an adapter that quietly implements two would make the
executor's dispatch ambiguous.

Rejecting at register time means the failure is a crash on boot, not a cell that
fails halfway through a paid run.

### The adapter maps against real response fields

Field names came from `openapi.json`, not from the output names in the guide.
The response nests differently than the flat output suggests:

| Output field | Source |
|---|---|
| `linkedin_url` | built from `linkedin_primary_slug` — there is no URL field |
| `name` | `preferred_name`, falling back to `names[0]` |
| `domain` | `domains[0]` |
| `industry` | `li_industries` entry with `primary: true`, else the first |
| `headcount` | `employee_count_consensus.gte` — the API reports a *band*, and the lower bound is the safe estimate |
| `hq_location` | `location_consensus.{city, state_name, country_name}` joined |
| `founded_year` | year parsed out of `founded_on_consensus`, a date string |
| `funding_total` | `total_funding_consensus` |
| `description` | `short_description`, falling back to `long_description` |

### A terminal error propagates as-is

The guide asks that a terminal error surface as an `AdapterError` with
`retryable=false`. `FiberError` already carries `code`, `message` and
`retryable`, so it **structurally satisfies `AdapterError`** and needs no
translation. The adapter therefore has no try/catch at all, which is most of why
it stays close to the guide's expected size. `toAdapterError` in Step 6 handles
the non-Fiber cases.

### The contract test forces its own maintenance

`EXAMPLE_INPUTS` maps adapter id to a sample input, and one test asserts every
registered adapter has an entry. Adding an adapter in Step 7 without an example
fails the suite rather than silently skipping coverage.

The output check runs each adapter against `FakeFiberClient` and parses the
result with the adapter's own `output` schema — so "output parses its own
example" is verified against a real execution path rather than a hand-written
literal.

## Note on size

The adapter is **95 lines** against the guide's expected 40–60. The excess is
field-mapping: ten output fields, four of which need a fallback or a derivation
(`linkedin_url` construction, `parseYear`, the `hq_location` join, the
`li_industries` primary lookup). No client is inlined and there is no error
handling — the shape the guide was warning about is absent.

## Environment — typecheck is I/O-bound, not slow

`tsc --noEmit` reports:

```
1.28s user   0.34s system   0% cpu   7:19.42 total
```

1.3 seconds of CPU, seven minutes of wall clock, exit 0. The type-checking work
is nearly instant; the process is blocked reading `types.generated.d.ts`
(9.7 MB) at roughly 23 KB/s.

This is the same fault that makes `grep`, `head`, `sed`, `od` and `file` return
empty on that one file, and is likely related to the truncated npm tarballs in
Step 1. It is an environment problem, not a project problem.

Two changes were made in response:

- **`types.generated.ts` → `types.generated.d.ts`.** `skipLibCheck: true` only
  applies to declaration files, so this took the actual checking work down to
  ~1.3 s of CPU. The `fiber:types` script now emits `.d.ts`. Imports are
  unchanged — they resolve by module path, not filename.
- **`tests/scaffold.test.ts` deleted.** The Step 1 placeholder imported
  `@/inngest/client`, pulling the whole Inngest SDK (protobufjs, OpenTelemetry)
  into the test process. It cost **40 seconds of import time** and asserted that
  a constant equalled itself. Removing it took the suite from ~20 s to **261 ms**.

If typecheck stays painful, the durable fix is to prune the generated types to
the ten operations actually used; the file is currently ~150,000 lines
describing hundreds of endpoints.
