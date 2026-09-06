import { describe, expect, it } from "vitest";

import { fiberCompanyKitchenSink as adapter } from "@/enrichments/fiber.company.kitchenSink";
import type { AdapterError, Ctx } from "@/enrichments/types";
import { FakeFiberClient } from "@/fiber/fake";
import { isRetryable } from "@/fiber/errors";

const PATH = "/v1/kitchen-sink/company";

function context(): { ctx: Ctx; fiber: FakeFiberClient; logs: string[] } {
  const fiber = new FakeFiberClient({ inMemory: true });
  const logs: string[] = [];
  return { ctx: { fiber, logger: (m) => logs.push(m) }, fiber, logs };
}

describe("fiber.company.kitchenSink", () => {
  it("maps a match onto the declared output shape", async () => {
    const { ctx } = context();
    const value = await adapter.run!({ domain: "stripe.com" }, ctx);

    expect(value).not.toBeNull();
    expect(adapter.output.parse(value)).toEqual({
      linkedin_url: "https://www.linkedin.com/company/stripe",
      name: "Stripe",
      domain: "stripe.com",
      industry: null,
      headcount: null,
      hq_location: null,
      founded_year: 2010,
      funding_total: 8700000000,
      funding_stage: "Series I",
      description: "Financial infrastructure for the internet.",
    });
  });

  it("normalises the domain before calling Fiber", async () => {
    const { ctx, fiber } = context();
    await adapter.run!({ domain: "https://WWW.Stripe.com/pricing" }, ctx);

    // Same request hash as the bare domain: one cache entry, not two.
    const bare = context();
    await adapter.run!({ domain: "stripe.com" }, bare.ctx);
    expect(fiber.memoryLog.entries[0].requestHash).toBe(bare.fiber.memoryLog.entries[0].requestHash);
  });

  it("accepts a name when no domain is given", async () => {
    const { ctx } = context();
    await expect(adapter.run!({ name: "Stripe" }, ctx)).resolves.not.toBeNull();
  });

  it("rejects an input with neither domain nor name", () => {
    const parsed = adapter.inputs.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it("returns null when Fiber finds nothing — a success, not a failure", async () => {
    const { ctx, fiber } = context();
    fiber.program(PATH, { kind: "not_found" });

    await expect(adapter.run!({ domain: "no-such-company.invalid" }, ctx)).resolves.toBeNull();
  });

  it("propagates a terminal error as an AdapterError with retryable=false", async () => {
    const { ctx, fiber } = context();
    fiber.program(PATH, { kind: "terminal", status: 400, code: "INVALID_DOMAIN" });

    const error = (await adapter
      .run!({ domain: "stripe.com" }, ctx)
      .catch((e: unknown) => e)) as AdapterError;

    // FiberError structurally satisfies AdapterError: code, message, retryable.
    expect(error.code).toBe("INVALID_DOMAIN");
    expect(error.retryable).toBe(false);
    expect(typeof error.message).toBe("string");
    expect(isRetryable(error)).toBe(false);
  });

  it("propagates a retryable error so the executor can back off", async () => {
    const { ctx, fiber } = context();
    fiber.program(PATH, { kind: "retry_then_succeed", failures: 1 });

    const error = (await adapter
      .run!({ domain: "stripe.com" }, ctx)
      .catch((e: unknown) => e)) as AdapterError;
    expect(error.retryable).toBe(true);

    // The next attempt succeeds, which is what the executor's retry loop relies on.
    await expect(adapter.run!({ domain: "stripe.com" }, ctx)).resolves.not.toBeNull();
  });

  it("estimates the documented 2 credits per lookup", () => {
    expect(adapter.estimateCredits({ domain: "stripe.com" })).toBe(2);
  });

  it("keys the cache by id, version and normalised inputs", () => {
    expect(adapter.cacheKey({ domain: "https://www.Acme.com/" })).toBe(
      "fiber.company.kitchenSink:1:acme.com|",
    );
    expect(adapter.cacheKey({ name: "  Acme Inc " })).toBe(
      "fiber.company.kitchenSink:1:|acme inc",
    );
  });
});
