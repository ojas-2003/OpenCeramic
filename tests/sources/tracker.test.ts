import { beforeEach, describe, expect, it } from "vitest";

import { FakeFiberClient } from "@/fiber/fake";
import { fiberSourceTracker as source } from "@/sources/fiber.source.tracker";

const SIGNALS = "/v1/tracker/signals/{listId}";
const COMPANY_LISTS = "/v1/tracker/company-lists";
const PERSON_LISTS = "/v1/tracker/person-lists";

/** observedAt values in the fixture. sig_002 and sig_003 share the later one. */
const T1 = "2026-09-08T09:00:00.000Z";
const T2 = "2026-09-09T11:30:00.000Z";

let fiber: FakeFiberClient;
const ctx = () => ({ fiber, logger: () => {} });

const config = source.config.parse({
  listId: "trk_openceramic",
  entity: "company",
  ruleIds: ["new_funding_round"],
});

beforeEach(() => {
  fiber = new FakeFiberClient({ inMemory: true });
});

describe("tracker source — cursor", () => {
  it("imports every signal on a first poll and records where it got to", async () => {
    const result = await source.poll(config, {}, ctx());

    expect(result.rows.map((r) => r.identityKey)).toEqual([
      "https://linkedin.com/company/linear",
      "https://linkedin.com/company/resend",
    ]);
    expect(result.cursor.last_signal_at).toBe(T2);
    expect(result.cursor.seen_ids).toEqual(["sig_001", "sig_002"]);
  });

  it("filters out signals older than the cursor", async () => {
    const result = await source.poll(
      config,
      { last_signal_at: "2026-09-10T00:00:00.000Z" },
      ctx(),
    );

    expect(result.rows).toEqual([]);
    // Both fixture signals predate the cursor, so it must not move backwards.
    expect(result.cursor.last_signal_at).toBe("2026-09-10T00:00:00.000Z");
  });

  it("keeps an equal-timestamp signal it has not seen, and drops the one it has", async () => {
    fiber.program(SIGNALS, { kind: "fixture", key: "equalTimestamps" });

    // sig_002 and sig_003 both sit exactly on the cursor. Only sig_002 was seen.
    const result = await source.poll(
      config,
      { last_signal_at: T2, seen_ids: ["sig_002"] },
      ctx(),
    );

    expect(result.rows.map((r) => r.signal?.raw_id)).toEqual(["sig_003"]);
    expect(result.cursor.last_signal_at).toBe(T2);
    expect(result.cursor.seen_ids).toContain("sig_003");
  });

  it("re-polling the same signals a second time yields nothing", async () => {
    const first = await source.poll(config, {}, ctx());
    const second = await source.poll(config, first.cursor, ctx());

    expect(second.rows).toEqual([]);
    expect(second.cursor.last_signal_at).toBe(T2);
  });

  it("still advances past a signal it cannot turn into a row", async () => {
    fiber.program(SIGNALS, { kind: "fixture", key: "unidentifiable" });

    const result = await source.poll(config, {}, ctx());

    // No LinkedIn identity, so no row — but re-reading it forever helps nobody.
    expect(result.rows).toEqual([]);
    expect(result.cursor.last_signal_at).toBe(T2);
    expect(result.cursor.seen_ids).toEqual(["sig_004"]);
  });

  it("returns a cursor when the list is empty", async () => {
    fiber.program(SIGNALS, { kind: "fixture", key: "empty" });

    const result = await source.poll(config, { last_signal_at: T1 }, ctx());

    expect(result.rows).toEqual([]);
    expect(result.cursor).toEqual({ last_signal_at: T1, seen_ids: [] });
  });

  it("bounds seen_ids so the cursor cannot grow without limit", async () => {
    const previous = Array.from({ length: 600 }, (_, i) => `old_${i}`);
    const result = await source.poll(config, { last_signal_at: T1, seen_ids: previous }, ctx());

    expect(result.cursor.seen_ids).toHaveLength(500);
    // Newest first, so the freshly seen ids survive the trim.
    expect((result.cursor.seen_ids as string[]).slice(0, 2)).toEqual(["sig_001", "sig_002"]);
  });

  it("returns a cursor without calling Fiber when setup has not run", async () => {
    const result = await source.poll(
      source.config.parse({ entity: "company", ruleIds: [] }),
      {},
      ctx(),
    );

    expect(result.rows).toEqual([]);
    expect(result.cursor).toEqual({});
    expect(result.note).toContain("setup");
    expect(fiber.attempts(SIGNALS)).toBe(0);
  });
});

describe("tracker source — mapping", () => {
  it("carries the reason a row arrived", async () => {
    const [first] = (await source.poll(config, {}, ctx())).rows;

    expect(first.signal).toEqual({
      kind: "new_funding_round",
      reason: "Linear raised a $65M Series C led by Accel.",
      // eventDate, not observedAt: when it happened, not when we noticed.
      occurred_at: "2026-09-05T00:00:00.000Z",
      raw_id: "sig_001",
    });
    expect(first.values).toEqual({ "LinkedIn URL": "https://linkedin.com/company/linear" });
  });
});

describe("tracker source — identity", () => {
  it("prefers the signal's own URL", () => {
    expect(
      source.identityFor({
        entityType: "company",
        linkedinUrl: "https://www.LinkedIn.com/company/Stripe/",
        linkedinSlug: "ignored",
      }),
    ).toBe("https://linkedin.com/company/Stripe");
  });

  it("builds a URL from the slug, choosing the segment by entity type", () => {
    expect(
      source.identityFor({ entityType: "person", linkedinUrl: null, linkedinSlug: "williamhgates" }),
    ).toBe("https://linkedin.com/in/williamhgates");
    expect(
      source.identityFor({ entityType: "company", linkedinUrl: null, linkedinSlug: "google" }),
    ).toBe("https://linkedin.com/company/google");
  });

  it("returns null when the signal names no LinkedIn identity", () => {
    expect(
      source.identityFor({ entityType: "company", linkedinUrl: null, linkedinSlug: null }),
    ).toBeNull();
    expect(source.identityFor(null)).toBeNull();
  });
});

describe("tracker source — setup", () => {
  it("creates a company list, seeds it, and returns the list id", async () => {
    const patch = await source.setup!(
      source.config.parse({
        entity: "company",
        ruleIds: ["new_funding_round"],
        seedIdentifiers: ["stripe.com"],
      }),
      ctx(),
    );

    expect(patch).toEqual({ listId: "trk_openceramic" });
    expect(fiber.attempts(COMPANY_LISTS)).toBe(1);
    expect(fiber.attempts("/v1/tracker/company-lists/{listId}/companies")).toBe(1);
    expect(fiber.attempts(PERSON_LISTS)).toBe(0);
  });

  it("creates a person list when the config says people", async () => {
    await source.setup!(
      source.config.parse({
        entity: "person",
        ruleIds: ["person_changed_company"],
        seedIdentifiers: ["williamhgates"],
      }),
      ctx(),
    );

    expect(fiber.attempts(PERSON_LISTS)).toBe(1);
    expect(fiber.attempts("/v1/tracker/person-lists/{listId}/people")).toBe(1);
    expect(fiber.attempts(COMPANY_LISTS)).toBe(0);
  });

  it("skips the seed call when there is nothing to seed", async () => {
    await source.setup!(
      source.config.parse({ entity: "company", ruleIds: ["new_funding_round"] }),
      ctx(),
    );
    expect(fiber.attempts("/v1/tracker/company-lists/{listId}/companies")).toBe(0);
  });

  it("does nothing when the config already names a list", async () => {
    expect(await source.setup!(config, ctx())).toEqual({});
    expect(fiber.attempts(COMPANY_LISTS)).toBe(0);
  });
});
