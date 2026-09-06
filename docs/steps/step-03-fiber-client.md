# Step 3 — Fiber client + fake client

**Commit:** `4a7f7b0` · **Verify:** `pnpm typecheck` clean · `pnpm test` 45 passed

## Delivered

| File | Purpose |
|---|---|
| `src/fiber/client.ts` | `FiberClient` interface, HTTP implementation, request hashing, credit extraction, `api_calls` logging |
| `src/fiber/errors.ts` | `FiberError`, retryable/terminal mapping, `isRetryable` |
| `src/fiber/fake.ts` | `FakeFiberClient` with programmable behaviours |
| `src/fiber/index.ts` | `getFiberClient()` — the only place that picks an implementation |
| `src/fiber/fixtures/*.json` | Eight fixtures |
| `tests/fiber/*` | 45 tests |

## What the docs actually say

Both answers came from `https://api.fiber.ai/llms.txt` and `openapi.json`, not
from assumption.

### Authentication

- **POST/PATCH/PUT** — `apiKey` in the JSON **body**
- **GET/DELETE** — `apiKey` in the **query string**
- `x-api-key: sk_live_xxx` and `Authorization: Bearer sk_live_xxx` are accepted
  alternatives; **body/query take precedence when both are present**

The client sends the documented primary form *plus* the `x-api-key` header.
Tests assert that a POST carries the key in the body and that the URL never
contains `apiKey`.

### Credits — `chargeInfo.creditsCharged`

A **required** sibling of `output`, discriminated on `method`:

| `method` | Field | Counted as |
|---|---|---|
| `charged-now` | `creditsCharged` | billed |
| `charged-for-async-process` | `creditsCharged` | billed |
| `credits-refunded` | `creditsRefunded` | negative |
| `charging-later` | `message` | 0 |
| `free` | `message` | 0 |

All ten operations declare it. `llms.txt` also documents a nested
`output.chargeInfo` position, so both are read.

A refund is counted as a **negative** charge so that a run's `actual_credits`
reconciles against what was really billed.

## Design decisions

### The API key never reaches an adapter

`FiberRequestBody<P, M>` is the generated request body with `apiKey` omitted. The
client injects it. Adapters written in Steps 4 and 7 therefore *cannot*
accidentally handle or log the key, and `CLAUDE.md`'s rule that `FIBER_API_KEY`
lives only in `src/fiber/` is enforced by the type system rather than by
discipline. Verified by a script asserting no `api.fiber.ai` or `FIBER_API_KEY`
outside `src/fiber/`.

### The request hash excludes the API key

Hashing covers the request body with `apiKey` stripped, so the same lookup made
under a different key still collapses to one cache entry in Step 6, and no key
material is derived into the `api_calls` audit trail.

Hashing is a hand-written canonical stringify — keys sorted at every depth,
`undefined` dropped, array order preserved. Array order is meaningful and is
deliberately *not* normalised.

### `api_calls` is written on failure too

Every call logs a row: successes, non-2xx responses, and transport failures
(logged with `http_status = null`). The audit trail answers "what did we send and
what came back", which is worthless if it only records successes. Cost
reconciliation in Step 6 sums this table.

### Logging is an injected dependency

`ApiCallLogger` has two implementations: `MemoryApiCallLogger` for tests, and a
database-backed one that imports `src/db/client` **lazily**. That laziness
matters — `src/db/client.ts` throws when `DATABASE_URL` is unset, so an eager
import would make the whole Fiber layer untestable without a database.

### The fake differs from the real client in transport only

`FakeFiberClient` implements the same interface, writes `api_calls` through the
same abstraction, and computes credits with the *same* `extractCredits`
function. Behaviour is programmable per path:

| Behaviour | Simulates |
|---|---|
| `fixture` | normal success |
| `not_found` | Fiber found nothing — a success with an empty result |
| `retry_then_succeed` | N retryable failures, then success |
| `terminal` | a non-retryable 4xx |

`not_found` being a *success* is the rule from `CLAUDE.md`: an unfindable email
must not look like a bug.

### Errors are split by retryability at the boundary

429, any 5xx, and transport failures (status 0) are retryable. Every other 4xx is
terminal — including 402 out-of-credits, which should stop a run rather than
hammer a drained account. Fiber's own `errorCode` and `message` are preferred
over generic defaults when present. This split is the contract Step 6's retry
loop depends on.

## Deviation

### Fixture type assertions widen literals

Fixtures are `.json` as the guide specifies, and each is checked against its
generated response type with `satisfies`, so drift fails `pnpm typecheck` rather
than a demo.

TypeScript widens string literals when importing a `.json` module, so
`"charged-now"` arrives typed as `string` and can never satisfy a literal union.
That is an import artifact, not drift. A `DeepWiden<T>` is applied to the
*expected* type, retaining every structural check — missing required fields,
misspelled or misnested keys, wrong container types, null where an object belongs
— and giving up only on exact enum spellings, which are then covered by runtime
assertions over every enum-valued field in the fixtures.

The alternative was `.ts` fixture files, which the guide explicitly said should
be JSON.

## Two corrections made during the step

Both were caught by verification, and both would have been silent failures.

### The credit extractor missed a billing variant

The first implementation handled only `charged-now`.
`charged-for-async-process` also bills, and it is what the async social-handles
adapter hits in Step 7 — run totals would have quietly under-reported. Fixed and
covered by tests.

### Four of five invented API paths were wrong

Paths were initially guessed. Extracting them from `openapi.json` gave:

| Operation | Guessed | Actual |
|---|---|---|
| `getCompanyRevenue` | `/v1/company/revenue` | `/v1/company-revenue` |
| `peopleSearch` | `/v1/search/people` | `/v1/people-search` |
| `emailBounceDetection` | `/v1/email/bounce-detection` | `/v1/validate-email/single` |
| `socialMediaLookupTrigger` | `/v1/social-media-finder/trigger` | `/v1/social-media-lookup/trigger` |
| `socialMediaLookupPolling` | `/v1/social-media-finder/poll` | `/v1/social-media-lookup/polling` |

`kitchenSinkCompany` and both batch contact paths were correct. All eight are now
asserted in a test.

## Environment note — do not grep the generated types

`grep`, `head`, `sed` and `file` all silently return nothing on
`src/fiber/types.generated.ts` (9.7 MB, very long lines). This produced a false
conclusion that `chargeInfo` did not exist in the spec, when in fact all ten
operations declare it.

Everything in this step was re-derived by reading the file through Node. **A
zero-result grep against that file means nothing.** Use:

```
node -e "const s=require('fs').readFileSync('src/fiber/types.generated.ts','utf8'); console.log(s.indexOf('chargeInfo'))"
```

## What Step 3 does not do

Nothing calls Fiber for real yet. `getFiberClient()` returns the fake under
`NODE_ENV=test` or `FIBER_FAKE=1`, and no adapter exists to invoke it. The first
live sandbox call is Step 7, which the guide asks to be done by hand with
`FIBER_FAKE=0` before the fixtures are trusted.
