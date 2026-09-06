import { describe, expect, it } from "vitest";

import {
  extractCredits,
  FiberHttpClient,
  hashRequest,
  MemoryApiCallLogger,
  stableStringify,
} from "@/fiber/client";
import {
  FiberError,
  fiberErrorFromNetwork,
  fiberErrorFromResponse,
  isRetryable,
} from "@/fiber/errors";
import { FakeFiberClient, listFixtures } from "@/fiber/fake";

/* ------------------------------------------------------------------ */
/* Request hashing                                                     */
/* ------------------------------------------------------------------ */

describe("request hashing", () => {
  it("is stable across key order", () => {
    const a = { companyDomain: { value: "stripe.com" }, companyName: { value: "Stripe" } };
    const b = { companyName: { value: "Stripe" }, companyDomain: { value: "stripe.com" } };
    expect(hashRequest(a)).toBe(hashRequest(b));
  });

  it("is stable across key order at every depth", () => {
    const a = { outer: { x: 1, inner: { p: true, q: [1, { m: 1, n: 2 }] } } };
    const b = { outer: { inner: { q: [1, { n: 2, m: 1 }], p: true }, x: 1 } };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(hashRequest(a)).toBe(hashRequest(b));
  });

  it("distinguishes different values", () => {
    expect(hashRequest({ v: "stripe.com" })).not.toBe(hashRequest({ v: "acme.com" }));
  });

  it("preserves array order, which is meaningful", () => {
    expect(hashRequest({ v: [1, 2] })).not.toBe(hashRequest({ v: [2, 1] }));
  });

  it("drops undefined values like JSON.stringify does", () => {
    expect(hashRequest({ a: 1, b: undefined })).toBe(hashRequest({ a: 1 }));
  });
});

/* ------------------------------------------------------------------ */
/* Error mapping                                                       */
/* ------------------------------------------------------------------ */

describe("error mapping", () => {
  it.each([
    [429, true, "rate_limited"],
    [500, true, "server_error"],
    [502, true, "server_error"],
    [503, true, "server_error"],
  ])("status %i is retryable", (status, retryable, code) => {
    const e = fiberErrorFromResponse(status, null);
    expect(e.retryable).toBe(retryable);
    expect(e.code).toBe(code);
    expect(isRetryable(e)).toBe(true);
  });

  it.each([
    [400, "bad_request"],
    [401, "unauthorized"],
    [402, "out_of_credits"],
    [403, "forbidden"],
    [404, "not_found"],
  ])("status %i is terminal", (status, code) => {
    const e = fiberErrorFromResponse(status, null);
    expect(e.retryable).toBe(false);
    expect(e.code).toBe(code);
    expect(isRetryable(e)).toBe(false);
  });

  it("prefers Fiber's own errorCode and message from the body", () => {
    const e = fiberErrorFromResponse(400, {
      errorCode: "INVALID_COMPANY_IDENTIFIER",
      message: "companyIdentifier.value must be a LinkedIn URL",
    });
    expect(e.code).toBe("INVALID_COMPANY_IDENTIFIER");
    expect(e.message).toBe("companyIdentifier.value must be a LinkedIn URL");
    expect(e.retryable).toBe(false);
  });

  it("maps network failures to retryable status 0", () => {
    const e = fiberErrorFromNetwork(new TypeError("fetch failed"));
    expect(e.status).toBe(0);
    expect(e.code).toBe("network_error");
    expect(e.retryable).toBe(true);
  });

  it("maps timeouts to a distinct retryable code", () => {
    const abort = new Error("The operation timed out");
    abort.name = "TimeoutError";
    const e = fiberErrorFromNetwork(abort);
    expect(e.code).toBe("timeout");
    expect(e.retryable).toBe(true);
  });

  it("treats non-Fiber errors as terminal", () => {
    expect(isRetryable(new Error("boom"))).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Credits                                                             */
/* ------------------------------------------------------------------ */

describe("credit extraction", () => {
  it("reads chargeInfo.creditsCharged when charged now", () => {
    expect(
      extractCredits({ output: {}, chargeInfo: { method: "charged-now", creditsCharged: 2 } }),
    ).toBe(2);
  });

  it("reads the nested output.chargeInfo form documented in llms.txt", () => {
    expect(
      extractCredits({ output: { chargeInfo: { method: "charged-now", creditsCharged: 5 } } }),
    ).toBe(5);
  });

  it("counts charged-for-async-process, which also bills this call", () => {
    expect(
      extractCredits({
        output: {},
        chargeInfo: { method: "charged-for-async-process", creditsCharged: 3, message: "queued" },
      }),
    ).toBe(3);
  });

  it("counts a refund as negative so run totals reconcile", () => {
    expect(
      extractCredits({
        output: {},
        chargeInfo: { method: "credits-refunded", creditsRefunded: 2, message: "no data" },
      }),
    ).toBe(-2);
  });

  it.each(["charging-later", "free"])("counts %s as zero for this call", (method) => {
    expect(extractCredits({ output: {}, chargeInfo: { method, message: "n/a" } })).toBe(0);
  });

  it("returns 0 when chargeInfo is absent or malformed", () => {
    expect(extractCredits({ output: {} })).toBe(0);
    expect(extractCredits(null)).toBe(0);
    expect(extractCredits({ chargeInfo: "nope" })).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Fake client                                                         */
/* ------------------------------------------------------------------ */

const KITCHEN_SINK = "/v1/kitchen-sink/company";

describe("FakeFiberClient", () => {
  it("serves the fixture and reports its credits", async () => {
    const fiber = new FakeFiberClient({ inMemory: true });
    const res = await fiber.call(KITCHEN_SINK, "post", {
      companyDomain: { value: "stripe.com" },
    });

    expect(res.data.output.data[0].preferred_name).toBe("Stripe");
    expect(res.credits).toBe(2);
    expect(res.apiCallId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("logs an api_calls row per call, like the real client", async () => {
    const fiber = new FakeFiberClient({ inMemory: true });
    await fiber.call(KITCHEN_SINK, "post", { companyDomain: { value: "stripe.com" } });

    expect(fiber.memoryLog.entries).toHaveLength(1);
    const [entry] = fiber.memoryLog.entries;
    expect(entry.endpoint).toBe(KITCHEN_SINK);
    expect(entry.httpStatus).toBe(200);
    expect(entry.credits).toBe(2);
    expect(entry.requestHash).toHaveLength(64);
  });

  it("returns an empty result set for not_found — a success, not a failure", async () => {
    const fiber = new FakeFiberClient({ inMemory: true });
    fiber.program(KITCHEN_SINK, { kind: "not_found" });

    const res = await fiber.call(KITCHEN_SINK, "post", { companyDomain: { value: "nope.dev" } });
    expect(res.data.output.data).toHaveLength(0);
    expect(res.credits).toBe(0);
  });

  it("throws retryable errors N times then succeeds", async () => {
    const fiber = new FakeFiberClient({ inMemory: true });
    fiber.program(KITCHEN_SINK, { kind: "retry_then_succeed", failures: 2 });
    const body = { companyDomain: { value: "stripe.com" } } as const;

    await expect(fiber.call(KITCHEN_SINK, "post", body)).rejects.toMatchObject({
      retryable: true,
      status: 429,
    });
    await expect(fiber.call(KITCHEN_SINK, "post", body)).rejects.toMatchObject({
      retryable: true,
    });

    const res = await fiber.call(KITCHEN_SINK, "post", body);
    expect(res.data.output.data[0].preferred_name).toBe("Stripe");
    expect(fiber.attempts(KITCHEN_SINK)).toBe(3);
    // Every attempt, failed or not, is auditable.
    expect(fiber.memoryLog.entries).toHaveLength(3);
    expect(fiber.memoryLog.entries.map((e) => e.httpStatus)).toEqual([429, 429, 200]);
  });

  it("throws terminal errors without retrying", async () => {
    const fiber = new FakeFiberClient({ inMemory: true });
    fiber.program(KITCHEN_SINK, { kind: "terminal", status: 400, code: "bad_request" });

    const err = await fiber
      .call(KITCHEN_SINK, "post", { companyDomain: { value: "stripe.com" } })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FiberError);
    expect(isRetryable(err)).toBe(false);
    expect((err as FiberError).status).toBe(400);
  });

  it("keys fixture responses by request hash when one is present", async () => {
    const fiber = new FakeFiberClient({ inMemory: true });
    // socialMediaLookupPolling ships an extra "pending" keyed response.
    const res = await fiber.call("/v1/social-media-lookup/polling", "post", {
      socialMediaFinderRunId: "smf_01HZY8QK3M4N5P6R7S8T9UVWXY",
    });
    expect(res.data.output.status).toBe("completed");
  });

  it("reset() clears programmed behaviour, attempts and the log", async () => {
    const fiber = new FakeFiberClient({ inMemory: true });
    fiber.program(KITCHEN_SINK, { kind: "terminal" });
    await fiber.call(KITCHEN_SINK, "post", {}).catch(() => undefined);

    fiber.reset();
    expect(fiber.attempts(KITCHEN_SINK)).toBe(0);
    expect(fiber.memoryLog.entries).toHaveLength(0);

    const res = await fiber.call(KITCHEN_SINK, "post", {});
    expect(res.data.output.data).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Fixture coverage                                                    */
/* ------------------------------------------------------------------ */

describe("fixtures", () => {
  it("cover every operation the adapters need", () => {
    expect(listFixtures().map((f) => f.operationId).sort()).toEqual([
      "emailBounceDetection",
      "getCompanyRevenue",
      "kitchenSinkCompany",
      "peopleSearch",
      "pollBatchContactDetails",
      "socialMediaLookupPolling",
      "socialMediaLookupTrigger",
      "startBatchContactDetails",
    ]);
  });

  it("each declare a wildcard response and a notFound variant", () => {
    for (const f of listFixtures()) {
      expect(f.responses["*"], `${f.operationId} wildcard`).toBeDefined();
      expect(f.notFound, `${f.operationId} notFound`).toBeDefined();
    }
  });
});

/* ------------------------------------------------------------------ */
/* HTTP client (transport stubbed, no network)                         */
/* ------------------------------------------------------------------ */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("FiberHttpClient", () => {
  it("sends apiKey in the body for POST and never in the query", async () => {
    const logger = new MemoryApiCallLogger();
    let seenUrl = "";
    let seenInit: RequestInit | undefined;

    const client = new FiberHttpClient({
      apiKey: "sk_live_test",
      baseUrl: "https://api.fiber.ai",
      logger,
      fetchImpl: async (url, init) => {
        seenUrl = String(url);
        seenInit = init;
        return jsonResponse({
          output: { data: [] },
          chargeInfo: { method: "charged-now", creditsCharged: 2 },
        });
      },
    });

    const res = await client.call(KITCHEN_SINK, "post", {
      companyDomain: { value: "stripe.com" },
    });

    expect(seenUrl).toBe("https://api.fiber.ai/v1/kitchen-sink/company");
    expect(seenUrl).not.toContain("apiKey");
    expect(JSON.parse(String(seenInit?.body))).toMatchObject({
      apiKey: "sk_live_test",
      companyDomain: { value: "stripe.com" },
    });
    expect(res.credits).toBe(2);
  });

  it("sends apiKey in the query for GET", async () => {
    const logger = new MemoryApiCallLogger();
    let seenUrl = "";

    const client = new FiberHttpClient({
      apiKey: "sk_live_test",
      logger,
      fetchImpl: async (url) => {
        seenUrl = String(url);
        return jsonResponse({ output: { credits: 4900 } });
      },
    });

    await client.call("/v1/get-org-credits", "get", undefined);
    expect(seenUrl).toContain("apiKey=sk_live_test");
  });

  it("hashes the request without the API key", async () => {
    const logger = new MemoryApiCallLogger();
    const client = new FiberHttpClient({
      apiKey: "sk_live_secret",
      logger,
      fetchImpl: async () => jsonResponse({ output: { data: [] } }),
    });

    await client.call(KITCHEN_SINK, "post", { companyDomain: { value: "stripe.com" } });

    expect(logger.entries[0].requestHash).toBe(
      hashRequest({ companyDomain: { value: "stripe.com" } }),
    );
  });

  it("logs an api_calls row and throws a mapped error on non-2xx", async () => {
    const logger = new MemoryApiCallLogger();
    const client = new FiberHttpClient({
      apiKey: "sk_live_test",
      logger,
      fetchImpl: async () => jsonResponse({ errorCode: "RATE_LIMITED" }, 429),
    });

    const err = await client
      .call(KITCHEN_SINK, "post", { companyDomain: { value: "stripe.com" } })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FiberError);
    expect((err as FiberError).retryable).toBe(true);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0].httpStatus).toBe(429);
  });

  it("logs a row with no status and throws retryable when the transport fails", async () => {
    const logger = new MemoryApiCallLogger();
    const client = new FiberHttpClient({
      apiKey: "sk_live_test",
      logger,
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });

    const err = await client.call(KITCHEN_SINK, "post", {}).catch((e: unknown) => e);

    expect(isRetryable(err)).toBe(true);
    expect(logger.entries[0].httpStatus).toBeNull();
  });

  it("refuses to call without an API key", async () => {
    const client = new FiberHttpClient({ apiKey: "", logger: new MemoryApiCallLogger() });
    await expect(client.call(KITCHEN_SINK, "post", {})).rejects.toThrow("FIBER_API_KEY");
  });
});
