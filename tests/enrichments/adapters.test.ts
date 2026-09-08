import { describe, expect, it } from "vitest";

import { fiberCompanyRevenue } from "@/enrichments/fiber.company.revenue";
import { fiberCompanyTalentFlow } from "@/enrichments/fiber.company.talentFlow";
import { fiberContactReveal } from "@/enrichments/fiber.contact.reveal";
import { fiberEmailValidate } from "@/enrichments/fiber.email.validate";
import { fiberPeopleFindAtCompany } from "@/enrichments/fiber.people.findAtCompany";
import { fiberSocialHandles } from "@/enrichments/fiber.social.handles";
import type { Ctx } from "@/enrichments/types";
import { FakeFiberClient } from "@/fiber/fake";

function context(): { ctx: Ctx; fiber: FakeFiberClient } {
  const fiber = new FakeFiberClient({ inMemory: true });
  return { ctx: { fiber, logger: () => {} }, fiber };
}

const PERSON = "https://www.linkedin.com/in/patrickcollison";
const COMPANY = "https://www.linkedin.com/company/stripe";

/* ------------------------------------------------------------------ */

describe("fiber.company.revenue (sync)", () => {
  const PATH = "/v1/company-revenue";

  it("maps the revenue band and derives a midpoint estimate", async () => {
    const { ctx } = context();
    const value = await fiberCompanyRevenue.run!({ linkedin_url: COMPANY }, ctx);

    expect(fiberCompanyRevenue.output.parse(value)).toEqual({
      revenue_estimate: 4_000_000_000,
      currency: "USD",
      range_low: 3_000_000_000,
      range_high: 5_000_000_000,
    });
  });

  it("returns null when Fiber has no revenue estimate", async () => {
    const { ctx, fiber } = context();
    fiber.program(PATH, { kind: "not_found" });
    await expect(fiberCompanyRevenue.run!({ linkedin_url: COMPANY }, ctx)).resolves.toBeNull();
  });

  it("normalises the URL into the cache key", () => {
    expect(fiberCompanyRevenue.cacheKey({ linkedin_url: "WWW.LinkedIn.com/company/Stripe/" })).toBe(
      fiberCompanyRevenue.cacheKey({ linkedin_url: "https://linkedin.com/company/Stripe" }),
    );
  });
});

/* ------------------------------------------------------------------ */

describe("fiber.people.findAtCompany (sync)", () => {
  const PATH = "/v1/people-search";

  it("returns the top match using the API's real field names", async () => {
    const { ctx } = context();
    const value = await fiberPeopleFindAtCompany.run!(
      { company_linkedin_url: COMPANY, title_query: "CEO OR Founder" },
      ctx,
    );

    expect(fiberPeopleFindAtCompany.output.parse(value)).toEqual({
      linkedin_url: "https://www.linkedin.com/in/jane-doe-sandbox",
      full_name: "Jane Doe",
      title: "VP of Engineering",
      location: "San Francisco, California, United States",
    });
  });

  it("returns null when the search finds nobody", async () => {
    const { ctx, fiber } = context();
    fiber.program(PATH, { kind: "not_found" });

    await expect(
      fiberPeopleFindAtCompany.run!({ company_linkedin_url: COMPANY, title_query: "CEO" }, ctx),
    ).resolves.toBeNull();
  });

  it("defaults title_query to CEO OR Founder", () => {
    const parsed = fiberPeopleFindAtCompany.inputs.parse({ company_linkedin_url: COMPANY });
    expect(parsed.title_query).toBe("CEO OR Founder");
  });

  it("splits an OR query into one search term per alternative", async () => {
    const { ctx, fiber } = context();
    await fiberPeopleFindAtCompany.run!(
      { company_linkedin_url: COMPANY, title_query: "CEO OR Founder OR President" },
      ctx,
    );
    // Distinct queries must not collide in the cache.
    expect(fiber.memoryLog.entries[0].requestHash).not.toBe(
      (await (async () => {
        const other = context();
        await fiberPeopleFindAtCompany.run!(
          { company_linkedin_url: COMPANY, title_query: "CEO" },
          other.ctx,
        );
        return other.fiber.memoryLog.entries[0];
      })()).requestHash,
    );
  });
});

/* ------------------------------------------------------------------ */

describe("fiber.email.validate (sync)", () => {
  const PATH = "/v1/validate-email/single";

  it("treats verdict=ok as deliverable", async () => {
    const { ctx } = context();
    const value = await fiberEmailValidate.run!({ email: "patrick@stripe.com" }, ctx);
    expect(fiberEmailValidate.output.parse(value)).toEqual({ deliverable: true, status: "ok" });
  });

  it("reports an undeliverable address as a successful result, not a failure", async () => {
    const { ctx, fiber } = context();
    fiber.program(PATH, { kind: "not_found" });

    const value = await fiberEmailValidate.run!({ email: "nobody@example.invalid" }, ctx);
    expect(value).toEqual({ deliverable: false, status: "undeliverable" });
  });

  it("lowercases the email for the cache key", () => {
    expect(fiberEmailValidate.cacheKey({ email: "  Patrick@Stripe.COM " })).toBe(
      "fiber.email.validate:1:patrick@stripe.com",
    );
  });
});

/* ------------------------------------------------------------------ */

describe("fiber.contact.reveal (batch)", () => {
  it("maps results back by LinkedIn URL, not by position", async () => {
    const { ctx } = context();
    // Deliberately reversed relative to the fixture's pageResults order.
    const results = await fiberContactReveal.runBatch!(
      [{ linkedin_url: "https://www.linkedin.com/in/no-contact-found" }, { linkedin_url: PERSON }],
      ctx,
    );

    expect(results[0]).toBeNull(); // no outputs in the fixture
    expect(results[1]).toEqual({
      email: "patrick@stripe.com",
      email_status: "valid",
      phone: "+14155550123",
    });
  });

  it("returns null for a person the batch found nothing for", async () => {
    const { ctx } = context();
    const [only] = await fiberContactReveal.runBatch!(
      [{ linkedin_url: "https://www.linkedin.com/in/nobody-at-all" }],
      ctx,
    );
    expect(only).toBeNull();
  });

  it("declares a batch size that fits inside one Inngest step", () => {
    expect(fiberContactReveal.batchSize).toBe(25);
    expect(fiberContactReveal.mode).toBe("batch");
    expect(fiberContactReveal.run).toBeUndefined();
  });

  it("starts one batch job for the whole chunk, not one per person", async () => {
    const { ctx, fiber } = context();
    await fiberContactReveal.runBatch!(
      [{ linkedin_url: PERSON }, { linkedin_url: "https://www.linkedin.com/in/someone-else" }],
      ctx,
    );

    const starts = fiber.memoryLog.entries.filter(
      (e) => e.endpoint === "/v1/contact-details/batch/start",
    );
    expect(starts).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */

describe("fiber.social.handles (async)", () => {
  const POLL = "/v1/social-media-lookup/polling";

  it("start returns Fiber's run id as the handle", async () => {
    const { ctx } = context();
    const { handle } = await fiberSocialHandles.start!({ linkedin_url: PERSON }, ctx);
    expect(handle).toBe("smf_01HZY8QK3M4N5P6R7S8T9UVWXY");
  });

  it("maps a completed lookup to the most confident handle per platform", async () => {
    const { ctx } = context();
    const result = await fiberSocialHandles.poll!("smf_1", ctx);

    expect(result.state).toBe("done");
    if (result.state !== "done") return;
    expect(fiberSocialHandles.output.parse(result.value)).toEqual({
      x_handle: "patrickc",
      instagram_handle: "patrickcollison",
    });
  });

  it("reports an in-progress run as pending", async () => {
    const { ctx, fiber } = context();
    fiber.program(POLL, { kind: "fixture", key: "pending" });

    const result = await fiberSocialHandles.poll!("smf_1", ctx);
    expect(result.state).toBe("pending");
  });

  it("returns done with a null value when no candidates were found", async () => {
    const { ctx, fiber } = context();
    fiber.program(POLL, { kind: "not_found" });

    const result = await fiberSocialHandles.poll!("smf_1", ctx);
    expect(result).toEqual({ state: "done", value: null });
  });

  it("implements start and poll but not run", () => {
    expect(fiberSocialHandles.mode).toBe("async");
    expect(typeof fiberSocialHandles.start).toBe("function");
    expect(typeof fiberSocialHandles.poll).toBe("function");
    expect(fiberSocialHandles.run).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */

describe("fiber.company.talentFlow (sync)", () => {
  const PATH = "/v1/talent-flow";

  it("ranks the companies a company trades people with", async () => {
    const { ctx } = context();
    const value = await fiberCompanyTalentFlow.run!(
      { linkedin_url: COMPANY, direction: "joiners" },
      ctx,
    );

    expect(fiberCompanyTalentFlow.output.parse(value)).toEqual({
      direction: "joiners",
      people_analysed: 1284,
      top_source: "Google",
      top_source_share: 10.7,
      top_sources: "Google, Amazon, Meta, Coinbase, Plaid",
      median_tenure_months: 31,
      median_years_experience: 8.5,
    });
  });

  it("ranks by headcount, not by the order the API returned", async () => {
    const { ctx } = context();
    const value = (await fiberCompanyTalentFlow.run!(
      { linkedin_url: COMPANY, direction: "joiners" },
      ctx,
    )) as { top_sources: string };
    // Google (138) outranks Amazon (96) outranks Meta (74).
    expect(value.top_sources.split(", ").slice(0, 3)).toEqual(["Google", "Amazon", "Meta"]);
  });

  it("returns null when nobody moved — a successful empty result", async () => {
    const { ctx, fiber } = context();
    fiber.program(PATH, { kind: "not_found" });
    await expect(
      fiberCompanyTalentFlow.run!({ linkedin_url: COMPANY, direction: "joiners" }, ctx),
    ).resolves.toBeNull();
  });

  it("defaults to joiners", () => {
    expect(fiberCompanyTalentFlow.inputs.parse({ linkedin_url: COMPANY }).direction).toBe("joiners");
  });

  it("keys joiners and leavers separately — they are different questions", () => {
    expect(fiberCompanyTalentFlow.cacheKey({ linkedin_url: COMPANY, direction: "joiners" })).not.toBe(
      fiberCompanyTalentFlow.cacheKey({ linkedin_url: COMPANY, direction: "leavers" }),
    );
  });

  it("caches longer than the default, since a report takes up to two minutes", () => {
    expect(fiberCompanyTalentFlow.ttlSeconds).toBeGreaterThan(7 * 24 * 60 * 60);
  });
});
