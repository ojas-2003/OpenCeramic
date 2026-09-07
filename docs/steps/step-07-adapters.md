# Step 7 — Remaining adapters

**Verify:** `vitest run` 150 passed · `tsc --noEmit` exit 0 · contract test covers six adapters

## Delivered

| Adapter | Mode | Endpoint | Lines | Credits |
|---|---|---|---|---|
| `fiber.company.kitchenSink` | sync | `/v1/kitchen-sink/company` | 95 | 2 |
| `fiber.company.revenue` | sync | `/v1/company-revenue` | 54 | 4 |
| `fiber.people.findAtCompany` | sync | `/v1/people-search` | 79 | 1 |
| `fiber.contact.reveal` | **batch** | `/v1/contact-details/batch/{start,poll}` | 108 | 5 |
| `fiber.email.validate` | sync | `/v1/validate-email/single` | 43 | 1 |
| `fiber.social.handles` | **async** | `/v1/social-media-lookup/{trigger,polling}` | 77 | 6 |

All three run modes are covered, and the contract test asserts that.

Credit costs are the documented per-operation prices, each cited in the adapter.

## Request shapes came from the spec, not from guesswork

Every one of these differs from the obvious guess:

| Operation | Request field |
|---|---|
| `getCompanyRevenue` | `companyMetadata: { linkedinUrl }` |
| `startBatchContactDetails` | `personDetails: [{ linkedinUrl: { value } }]` |
| `socialMediaLookupTrigger` | `person: { inputType: "linkedinUrl", linkedinUrl }` |
| `peopleSearch` | `currentCompanies: [{ linkedinSlugOrURL }]` + `searchParams.jobTitleV2.anyOf` |

The Step 5 sandbox probing surfaced the first three; the rest came out of
`openapi.json`.

## Design decisions

### `title_query` maps to `jobTitleV2.anyOf`, one term per alternative

"CEO OR Founder" splits on `OR` into `[{type:"term",term:"CEO"},{type:"term",term:"Founder"}]`,
which is Fiber's own disjunction. Ranking picks the winner and the adapter takes
`result[0]`, as the guide specifies.

**On `jobTitleRewrite`** (the guide asks this to be checked): it exists —
`POST /v1/typeahead/job-title`, "Job Title Synonym Expansion" — and would expand
"CEO" into its synonyms. Separately, `jobTitleV2` supports `static-groups` with
members `founder`, `c-suite` and `board-member`, which covers this default query
natively without a second call.

Neither is used. `jobTitleRewrite` is an extra API call per cell, costing credits
and latency on every row, and the static groups are less general than free text.
Plain terms are enough for the demo. Worth revisiting if match rates disappoint —
the static-groups route is the cheaper of the two.

### `revenue_estimate` is a midpoint, and the currency is assumed

Fiber returns `lowerBound`/`upperBound`/`fiscalYear` and **no currency field**.
`range_low` and `range_high` carry the band unchanged, `revenue_estimate` is the
midpoint, and `currency` is hardcoded to `"USD"`. That is an assumption, marked
in the adapter.

### The batch adapter chunks at 25, not Fiber's documented 2000

`startBatchContactDetails` documents a maximum of **2000** people per batch, and
the guide says to use the documented max. That is not usable here: `runBatch`
must start *and finish* inside a single Inngest step, polling with a 3-second
interval and 20 attempts (60 seconds). Two thousand people will not resolve in
that window, and a step that outlives its budget is worse than several smaller
ones.

`batchSize` is 25. The documented maximum is recorded in the adapter so the
tradeoff is visible. It still collapses 25 cells into one API call, which is the
lever the design doc cares about.

The poll runs *before* the first sleep, so a batch that is already complete costs
no extra wait.

### Results map back by LinkedIn URL, not by position

`pollBatchContactDetails` returns `pageResults` in its own order. Mapping
positionally would hand one person another person's phone number. The adapter
keys results by normalised URL and rebuilds the array in input order — asserted
by a test that deliberately reverses the input order relative to the fixture.

## A bug the tests caught

`fiber.contact.reveal` returned `{ email: null, email_status: null, phone: null }`
for a person Fiber found nothing for. That is an object, not a null, so it is a
*non-empty* value as far as the engine is concerned.

The consequence would have shown up in the demo chain: `email.validate` reads
`<contact column>` downstream, would have resolved that object, and then failed
with `invalid_input` on a null email — instead of cleanly skipping with "source
value is empty". A row with no contact now yields `null`, and the dependent cell
skips with a reason.

This is the same distinction Step 6 fixed for `batch_result_missing`: "nothing
found" and "no answer" are different, and both differ from "an answer full of
nulls".

## Repository hygiene: six committed iCloud conflict copies

`git ls-files` turned up six duplicate files committed during Step 4, created by
iCloud while the repo was still under `~/Desktop`:

```
src/enrichments/fiber.company.kitchenSink 2.ts
src/enrichments/index 2.ts
src/enrichments/normalize 2.ts
src/enrichments/registry 2.ts
src/enrichments/types 2.ts
tests/fiber/fixtures.types.test 2.ts
```

None was imported and none was collected by vitest (`* 2.ts` does not match
`*.test.ts`), so nothing behaved incorrectly — but they were dead weight in the
repository, and the two that differed were merely *older* snapshots of files
that have since grown.

All six are removed, and `tests/repo-hygiene.test.ts` now fails if a
conflict-copy file is ever committed again. This is the same fault that put
duplicate branch refs in `.git/refs/heads/` and broke `git clone` during the
move.

## Still not verified against the live API

`kitchenSinkCompany`, `emailBounceDetection`, `pollBatchContactDetails` and
`socialMediaLookupPolling` all return **501 Sandbox mode is not yet available**.
Their fixtures remain unvalidated against real responses.

Given that the one fixture that *could* be checked (`peopleSearch`) turned out to
have three invented field names, the others should be assumed wrong until a live
key is available. The adapters' response mappings are typed against
`openapi.json`, so the shapes are right; it is the values and optionality that
are unproven.
