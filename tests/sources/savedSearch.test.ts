import { beforeEach, describe, expect, it } from "vitest";

import { hashRequest } from "@/fiber/client";
import { FakeFiberClient } from "@/fiber/fake";
import { fiberSourceSavedSearch as source } from "@/sources/fiber.source.savedSearch";

const LATEST = "/v1/saved-search/run/get-latest";
const STATUS = "/v1/saved-search/run/status";
const COMPANIES = "/v1/saved-search/run/companies";

/** The run id the get-latest fixture reports. */
const RUN_ID = "ssr_2026_09_09";

let fiber: FakeFiberClient;
const ctx = () => ({ fiber, logger: () => {} });

const companyConfig = source.config.parse({
  savedSearchId: "ss_seedstage_saas",
  entity: "company",
});
const personConfig = source.config.parse({
  savedSearchId: "ss_seedstage_saas",
  entity: "person",
});

beforeEach(() => {
  fiber = new FakeFiberClient({ inMemory: true });
});

describe("saved search source — cursor", () => {
  it("does nothing when the latest run is the one already imported", async () => {
    const cursor = { last_run_id: RUN_ID };
    const result = await source.poll(companyConfig, cursor, ctx());

    expect(result.rows).toEqual([]);
    expect(result.cursor).toEqual(cursor);
    // It should not even ask for the status of a run it has already read.
    expect(fiber.attempts(STATUS)).toBe(0);
    expect(fiber.attempts(COMPANIES)).toBe(0);
  });

  it("leaves the cursor untouched while a run is still building", async () => {
    fiber.program(STATUS, { kind: "fixture", key: "processing" });

    const result = await source.poll(companyConfig, {}, ctx());

    expect(result.rows).toEqual([]);
    expect(result.cursor).toEqual({});
    expect(result.note).toBe("run in progress");
    // Advancing here would skip this run's results permanently.
    expect(result.cursor.last_run_id).toBeUndefined();
    expect(fiber.attempts(COMPANIES)).toBe(0);
  });

  it("leaves the cursor untouched when a run failed outright", async () => {
    fiber.program(STATUS, { kind: "fixture", key: "failed" });

    const result = await source.poll(companyConfig, {}, ctx());

    expect(result.rows).toEqual([]);
    expect(result.cursor).toEqual({});
    expect(result.note).toBe("run rejected no funds");
  });

  it("advances the cursor to the run it just imported", async () => {
    const result = await source.poll(companyConfig, {}, ctx());
    expect(result.cursor).toEqual({ last_run_id: RUN_ID });
  });

  it("preserves unrelated cursor keys when it advances", async () => {
    const result = await source.poll(companyConfig, { seen_ids: ["x"] }, ctx());
    expect(result.cursor).toEqual({ seen_ids: ["x"], last_run_id: RUN_ID });
  });

  it("returns a cursor without calling Fiber when setup has not run", async () => {
    const result = await source.poll(
      source.config.parse({ entity: "company" }),
      {},
      ctx(),
    );

    expect(result.rows).toEqual([]);
    expect(result.cursor).toEqual({});
    expect(result.note).toContain("setup");
    expect(fiber.attempts(LATEST)).toBe(0);
  });
});

describe("saved search source — mapping", () => {
  it("maps a completed company run onto rows keyed by normalized domain", async () => {
    const result = await source.poll(companyConfig, {}, ctx());

    expect(result.rows).toEqual([
      {
        identityKey: "stripe.com",
        values: {
          Website: "stripe.com",
          Name: "Stripe",
          "LinkedIn URL": "https://linkedin.com/company/stripe",
        },
      },
      {
        identityKey: "linear.app",
        values: {
          Website: "linear.app",
          Name: "Linear",
          "LinkedIn URL": "https://linkedin.com/company/linear",
        },
      },
    ]);
  });

  it("skips a company it cannot address", async () => {
    // The fixture's third company has no domain at all.
    const result = await source.poll(companyConfig, {}, ctx());
    expect(result.rows.map((r) => r.identityKey)).not.toContain("");
    expect(result.rows).toHaveLength(2);
  });

  it("maps a completed person run onto rows keyed by LinkedIn URL", async () => {
    const result = await source.poll(personConfig, {}, ctx());

    expect(result.rows).toEqual([
      {
        identityKey: "https://linkedin.com/in/patrickcollison",
        values: {
          "LinkedIn URL": "https://linkedin.com/in/patrickcollison",
          Name: "Patrick Collison",
        },
      },
      {
        identityKey: "https://linkedin.com/in/karrisaarinen",
        values: {
          "LinkedIn URL": "https://linkedin.com/in/karrisaarinen",
          Name: "Karri Saarinen",
        },
      },
    ]);
    expect(fiber.attempts(COMPANIES)).toBe(0);
  });

  it("asks only for arrivals, never for departures", async () => {
    await source.poll(companyConfig, {}, ctx());

    // api_calls records the request hash, not the body, so the assertion is
    // made by hashing the body we expect. Adding "departed" — which would
    // insert companies that just left the search — changes the hash.
    const call = fiber.memoryLog.entries.find((e) => e.endpoint === COMPANIES);
    expect(call?.requestHash).toBe(
      hashRequest({
        savedSearchRunId: RUN_ID,
        statuses: ["joined", "returned"],
        pageSize: 100,
      }),
    );
  });
});

describe("saved search source — identity", () => {
  it("collapses spellings of one company to a single key", () => {
    for (const domain of ["https://www.Stripe.com/", "stripe.com", "STRIPE.COM:443"]) {
      expect(source.identityFor({ company: { domains: [domain] } })).toBe("stripe.com");
    }
  });

  it("builds a person's URL from the slug when the profile carries none", () => {
    expect(source.identityFor({ profile: { primary_slug: "patrickcollison" } })).toBe(
      "https://linkedin.com/in/patrickcollison",
    );
  });

  it("returns null for anything it cannot key", () => {
    expect(source.identityFor({ company: { domains: [] } })).toBeNull();
    expect(source.identityFor({ profile: {} })).toBeNull();
    expect(source.identityFor({})).toBeNull();
    expect(source.identityFor(null)).toBeNull();
  });
});

describe("saved search source — setup", () => {
  it("creates the search and returns its id", async () => {
    const patch = await source.setup!(
      source.config.parse({ entity: "company", searchParams: { domains: ["stripe.com"] } }),
      ctx(),
    );
    expect(patch).toEqual({ savedSearchId: "ss_seedstage_saas" });
  });

  it("does nothing when the config already names a search", async () => {
    const patch = await source.setup!(companyConfig, ctx());
    expect(patch).toEqual({});
    expect(fiber.attempts("/v1/saved-search/create")).toBe(0);
  });
});
