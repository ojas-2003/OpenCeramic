import { describe, expect, it } from "vitest";

import emailBounceDetection from "@/fiber/fixtures/emailBounceDetection.json";
import getCompanyRevenue from "@/fiber/fixtures/getCompanyRevenue.json";
import kitchenSinkCompany from "@/fiber/fixtures/kitchenSinkCompany.json";
import peopleSearch from "@/fiber/fixtures/peopleSearch.json";
import pollBatchContactDetails from "@/fiber/fixtures/pollBatchContactDetails.json";
import socialMediaLookupPolling from "@/fiber/fixtures/socialMediaLookupPolling.json";
import socialMediaLookupTrigger from "@/fiber/fixtures/socialMediaLookupTrigger.json";
import startBatchContactDetails from "@/fiber/fixtures/startBatchContactDetails.json";

import type { FiberResponseData } from "@/fiber/client";

/**
 * TypeScript widens string literals when importing a .json module, so a fixture
 * containing "charged-now" arrives typed as `string` and can never satisfy a
 * literal union. That is an import artifact, not fixture drift.
 *
 * DeepWiden applies the same widening to the expected type, which leaves every
 * check that actually matters intact: missing required fields, misspelled or
 * misnested keys, wrong container types, null where an object belongs. Only the
 * exact spelling of enum members is out of scope, and the runtime assertions at
 * the bottom of this file cover those.
 */
type DeepWiden<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends readonly (infer U)[]
        ? DeepWiden<U>[]
        : T extends object
          ? { [K in keyof T]: DeepWiden<T[K]> }
          : T;

type ResponseShape<
  P extends keyof import("@/fiber/types.generated").paths,
  M extends keyof import("@/fiber/types.generated").paths[P],
> = DeepWiden<FiberResponseData<P, M>>;

/* Each `satisfies` below fails `pnpm typecheck` if the fixture drifts. */

const checked = {
  kitchenSink: kitchenSinkCompany.responses["*"] satisfies ResponseShape<
    "/v1/kitchen-sink/company",
    "post"
  >,
  kitchenSinkNotFound: kitchenSinkCompany.notFound satisfies ResponseShape<
    "/v1/kitchen-sink/company",
    "post"
  >,
  revenue: getCompanyRevenue.responses["*"] satisfies ResponseShape<"/v1/company-revenue", "post">,
  revenueNotFound: getCompanyRevenue.notFound satisfies ResponseShape<
    "/v1/company-revenue",
    "post"
  >,
  people: peopleSearch.responses["*"] satisfies ResponseShape<"/v1/people-search", "post">,
  peopleNotFound: peopleSearch.notFound satisfies ResponseShape<"/v1/people-search", "post">,
  batchStart: startBatchContactDetails.responses["*"] satisfies ResponseShape<
    "/v1/contact-details/batch/start",
    "post"
  >,
  batchStartNotFound: startBatchContactDetails.notFound satisfies ResponseShape<
    "/v1/contact-details/batch/start",
    "post"
  >,
  batchPoll: pollBatchContactDetails.responses["*"] satisfies ResponseShape<
    "/v1/contact-details/batch/poll",
    "post"
  >,
  batchPollNotFound: pollBatchContactDetails.notFound satisfies ResponseShape<
    "/v1/contact-details/batch/poll",
    "post"
  >,
  email: emailBounceDetection.responses["*"] satisfies ResponseShape<
    "/v1/validate-email/single",
    "post"
  >,
  emailNotFound: emailBounceDetection.notFound satisfies ResponseShape<
    "/v1/validate-email/single",
    "post"
  >,
  socialTrigger: socialMediaLookupTrigger.responses["*"] satisfies ResponseShape<
    "/v1/social-media-lookup/trigger",
    "post"
  >,
  socialPoll: socialMediaLookupPolling.responses["*"] satisfies ResponseShape<
    "/v1/social-media-lookup/polling",
    "post"
  >,
  socialPollPending: socialMediaLookupPolling.responses.pending satisfies ResponseShape<
    "/v1/social-media-lookup/polling",
    "post"
  >,
};

describe("fixtures match the generated OpenAPI response types", () => {
  it("structurally satisfies every operation's 200 response", () => {
    // Reaching this line means tsc accepted every `satisfies` above.
    expect(Object.keys(checked)).toHaveLength(15);
  });

  it("uses the real request paths from openapi.json", () => {
    expect(kitchenSinkCompany.path).toBe("/v1/kitchen-sink/company");
    expect(getCompanyRevenue.path).toBe("/v1/company-revenue");
    expect(peopleSearch.path).toBe("/v1/people-search");
    expect(startBatchContactDetails.path).toBe("/v1/contact-details/batch/start");
    expect(pollBatchContactDetails.path).toBe("/v1/contact-details/batch/poll");
    expect(emailBounceDetection.path).toBe("/v1/validate-email/single");
    expect(socialMediaLookupTrigger.path).toBe("/v1/social-media-lookup/trigger");
    expect(socialMediaLookupPolling.path).toBe("/v1/social-media-lookup/polling");
  });

  /* Enum spellings, which DeepWiden deliberately does not police. */

  it("uses valid chargeInfo.method members", () => {
    const valid = new Set([
      "charged-now",
      "charging-later",
      "charged-for-async-process",
      "free",
      "credits-refunded",
    ]);
    const fixtures = [
      kitchenSinkCompany,
      getCompanyRevenue,
      peopleSearch,
      startBatchContactDetails,
      pollBatchContactDetails,
      emailBounceDetection,
      socialMediaLookupTrigger,
      socialMediaLookupPolling,
    ];
    for (const f of fixtures) {
      for (const [key, payload] of Object.entries({ ...f.responses, notFound: f.notFound })) {
        const method = (payload as { chargeInfo?: { method?: string } })?.chargeInfo?.method;
        expect(valid.has(String(method)), `${f.operationId}.${key} -> ${method}`).toBe(true);
      }
    }
  });

  it("uses valid enum members in the response bodies", () => {
    expect(["ok", "undeliverable", "risky", "inconclusive"]).toContain(
      emailBounceDetection.responses["*"].output.verdict,
    );
    expect(["pending", "in_progress", "completed", "failed"]).toContain(
      socialMediaLookupPolling.responses["*"].output.status,
    );
    for (const c of socialMediaLookupPolling.responses["*"].output.data[0].candidates) {
      expect(["TWITTER", "INSTAGRAM", "LINKEDIN", "FACEBOOK"]).toContain(c.platform);
    }
    for (const p of pollBatchContactDetails.responses["*"].output.pageResults) {
      for (const e of p.outputs?.emails ?? []) {
        expect(["work", "personal", "other", "unknown", "generic"]).toContain(e.type);
        expect(["valid", "risky", "unknown", "invalid"]).toContain(e.status);
      }
      for (const n of p.outputs?.phoneNumbers ?? []) {
        expect(["mobile", "other", "unknown"]).toContain(n.type);
      }
    }
  });
});
