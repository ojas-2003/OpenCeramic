import { describe, expect, it } from "vitest";

import "@/enrichments";
import { normalizeDomain, normalizeEmail, normalizeUrl } from "@/enrichments/normalize";
import { list } from "@/enrichments/registry";
import type { AnyEnrichment } from "@/enrichments/types";
import { FakeFiberClient, getFixture } from "@/fiber/fake";

/**
 * One example input per adapter. A new adapter with no entry here fails the
 * first test below, which keeps this file honest as adapters are added in
 * Step 7.
 */
const EXAMPLE_INPUTS: Record<string, unknown> = {
  "fiber.company.kitchenSink": { domain: "stripe.com" },
  "fiber.company.revenue": { linkedin_url: "https://www.linkedin.com/company/stripe" },
  "fiber.people.findAtCompany": {
    company_linkedin_url: "https://www.linkedin.com/company/stripe",
    title_query: "CEO OR Founder",
  },
  "fiber.contact.reveal": { linkedin_url: "https://www.linkedin.com/in/patrickcollison" },
  "fiber.email.validate": { email: "patrick@stripe.com" },
  "fiber.social.handles": { linkedin_url: "https://www.linkedin.com/in/patrickcollison" },
};

const adapters = list();

const ctx = () => ({
  fiber: new FakeFiberClient({ inMemory: true }),
  logger: () => {},
});

describe("adapter contract", () => {
  it("registers all six adapters across all three run modes", () => {
    expect(adapters.map((a) => a.id).sort()).toEqual([
      "fiber.company.kitchenSink",
      "fiber.company.revenue",
      "fiber.contact.reveal",
      "fiber.email.validate",
      "fiber.people.findAtCompany",
      "fiber.social.handles",
    ]);
    expect(new Set(adapters.map((a) => a.mode))).toEqual(new Set(["sync", "batch", "async"]));
  });

  it("has an example input for every registered adapter", () => {
    for (const a of adapters) {
      expect(EXAMPLE_INPUTS, `missing EXAMPLE_INPUTS entry for ${a.id}`).toHaveProperty(a.id);
    }
  });

  it("gives every adapter a unique id in the fiber.* namespace", () => {
    const ids = adapters.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^fiber\./);
  });

  it("declares a positive version and a non-empty label and description", () => {
    for (const a of adapters) {
      expect(a.version, a.id).toBeGreaterThan(0);
      expect(a.label.length, a.id).toBeGreaterThan(0);
      expect(a.description.length, a.id).toBeGreaterThan(0);
    }
  });

  it("implements exactly the methods its mode requires", () => {
    const required: Record<string, string[]> = {
      sync: ["run"],
      batch: ["runBatch"],
      async: ["start", "poll"],
    };
    const all = ["run", "runBatch", "start", "poll"] as const;

    for (const a of adapters) {
      const need = required[a.mode];
      expect(need, `${a.id} has unknown mode ${a.mode}`).toBeDefined();

      for (const m of all) {
        const implemented = typeof (a as unknown as Record<string, unknown>)[m] === "function";
        expect(implemented, `${a.id} mode=${a.mode} method=${m}`).toBe(need.includes(m));
      }
    }
  });

  it("parses its own example input", () => {
    for (const a of adapters) {
      const parsed = a.inputs.safeParse(EXAMPLE_INPUTS[a.id]);
      expect(parsed.success, `${a.id}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it("produces output that parses against its own output schema", async () => {
    for (const a of adapters) {
      const input = a.inputs.parse(EXAMPLE_INPUTS[a.id]);
      const value = await runOnce(a, input);
      // null is a legitimate result (nothing found); only non-null must parse.
      if (value === null) continue;
      const parsed = a.output.safeParse(value);
      expect(parsed.success, `${a.id}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it("declares outputFields that exist in the output schema", async () => {
    for (const a of adapters) {
      const input = a.inputs.parse(EXAMPLE_INPUTS[a.id]);
      const value = (await runOnce(a, input)) as Record<string, unknown> | null;
      if (value === null) continue;
      for (const field of a.outputFields) {
        expect(Object.keys(value), `${a.id}.${field.key}`).toContain(field.key);
      }
    }
  });

  it("estimates a non-negative credit cost", () => {
    for (const a of adapters) {
      const input = a.inputs.parse(EXAMPLE_INPUTS[a.id]);
      expect(a.estimateCredits(input), a.id).toBeGreaterThanOrEqual(0);
    }
  });

  it("builds a cache key namespaced by id and version", () => {
    for (const a of adapters) {
      const input = a.inputs.parse(EXAMPLE_INPUTS[a.id]);
      expect(a.cacheKey(input), a.id).toContain(`${a.id}:${a.version}:`);
    }
  });
});

async function runOnce(a: AnyEnrichment, input: unknown): Promise<unknown> {
  const c = ctx();
  if (a.mode === "sync") return a.run!(input, c);
  if (a.mode === "batch") {
    const [first] = await a.runBatch!([input], c);
    return first;
  }
  const { handle } = await a.start!(input, c);
  const polled = await a.poll!(handle, c);
  return polled.state === "done" ? polled.value : null;
}

/**
 * The endpoint whose chargeInfo determines what a cell actually costs.
 * For the async and batch adapters that is the charging call, not the poll.
 */
const CHARGING_PATH: Record<string, string> = {
  "fiber.company.kitchenSink": "/v1/kitchen-sink/company",
  "fiber.company.revenue": "/v1/company-revenue",
  "fiber.people.findAtCompany": "/v1/people-search",
  "fiber.contact.reveal": "/v1/contact-details/batch/poll",
  "fiber.email.validate": "/v1/validate-email/single",
  "fiber.social.handles": "/v1/social-media-lookup/trigger",
};

describe("estimated credits match what the fixtures charge", () => {
  it("keeps estimateCredits and fixture chargeInfo in step", () => {
    for (const a of adapters) {
      const fixture = getFixture(CHARGING_PATH[a.id]);
      expect(fixture, `no fixture mapped for ${a.id}`).toBeDefined();

      const charge = (fixture!.responses["*"] as {
        chargeInfo?: { method?: string; creditsCharged?: number };
      }).chargeInfo;

      // "free" and "charging-later" bill elsewhere, so there is nothing to match.
      if (charge?.method !== "charged-now") continue;

      expect(charge.creditsCharged, `${a.id}: estimate vs fixture`).toBe(
        a.estimateCredits(EXAMPLE_INPUTS[a.id]),
      );
    }
  });
});

/* ------------------------------------------------------------------ */
/* Cache-key stability                                                 */
/* ------------------------------------------------------------------ */

describe("cache keys are stable under input normalisation", () => {
  it("collapses protocol, www, case, path and trailing slash for kitchenSink", () => {
    const a = adapters.find((x) => x.id === "fiber.company.kitchenSink")!;
    const canonical = a.cacheKey({ domain: "acme.com" });

    for (const variant of [
      "https://www.Acme.com/",
      "http://acme.com",
      "www.ACME.com",
      "  Acme.com  ",
      "https://acme.com/careers?utm=x",
      "acme.com:443",
    ]) {
      expect(a.cacheKey({ domain: variant }), variant).toBe(canonical);
    }
  });

  it("separates genuinely different inputs", () => {
    const a = adapters.find((x) => x.id === "fiber.company.kitchenSink")!;
    expect(a.cacheKey({ domain: "acme.com" })).not.toBe(a.cacheKey({ domain: "acme.io" }));
    expect(a.cacheKey({ domain: "acme.com" })).not.toBe(
      a.cacheKey({ domain: "acme.com", name: "Acme" }),
    );
  });
});

describe("normalisers", () => {
  it("normalizeDomain strips protocol, www, path, port and case", () => {
    expect(normalizeDomain("https://www.Acme.com/")).toBe("acme.com");
    expect(normalizeDomain("HTTP://ACME.COM/a/b?c=1#d")).toBe("acme.com");
    expect(normalizeDomain("acme.com:8080")).toBe("acme.com");
    expect(normalizeDomain("  acme.com. ")).toBe("acme.com");
    expect(normalizeDomain(undefined)).toBe("");
    expect(normalizeDomain("")).toBe("");
  });

  it("normalizeDomain keeps subdomains, which identify different companies", () => {
    expect(normalizeDomain("https://blog.acme.com")).toBe("blog.acme.com");
  });

  it("normalizeUrl keeps the path but drops case, www and trailing slash", () => {
    expect(normalizeUrl("HTTPS://WWW.LinkedIn.com/in/Jane/")).toBe(
      "https://linkedin.com/in/Jane",
    );
    expect(normalizeUrl("linkedin.com/in/jane")).toBe("https://linkedin.com/in/jane");
    expect(normalizeUrl(undefined)).toBe("");
  });

  it("normalizeEmail lowercases and trims", () => {
    expect(normalizeEmail("  Jane.Doe@Acme.COM ")).toBe("jane.doe@acme.com");
    expect(normalizeEmail(null)).toBe("");
  });
});
