import { z } from "zod";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { normalizeDomain, normalizeUrl } from "@/enrichments/normalize";
import { FakeFiberClient } from "@/fiber/fake";
import "@/sources";
import {
  clear,
  get,
  getOrThrow,
  list,
  listForEntity,
  register,
  SourceRegistryError,
} from "@/sources/registry";
import type { AnyRowSource, PollResult } from "@/sources/types";

/**
 * One example per source, mirroring EXAMPLE_INPUTS in the enrichment contract
 * test. A new source with no entry here fails the first test below, which is
 * what keeps this file honest as the two sources land in Step 3.
 */
type SourceExample = {
  /** Must parse against the source's own config schema. */
  config: unknown;
  /**
   * Items that name the same entity in different shapes. Every one must yield
   * the same identity key, or the same entity arrives twice as two rows.
   *
   * `normalizer` is declared rather than derived from `entity`, because which
   * one applies depends on what the API hands back, not on what the source
   * looks for: a tracker signal names a company only by LinkedIn URL, so a
   * company source can legitimately key on either.
   */
  identity: { items: unknown[]; expected: string; normalizer: "domain" | "url" };
  /** An item identityFor must reject by returning null. */
  unidentifiable: unknown;
};

const EXAMPLES: Record<string, SourceExample> = {
  "fiber.source.savedSearch": {
    config: { savedSearchId: "ss_seedstage_saas", entity: "company" },
    identity: {
      items: [
        { company: { domains: ["https://www.Stripe.com/"] } },
        { company: { domains: ["stripe.com"] } },
        { company: { domains: ["STRIPE.COM:443"] } },
      ],
      expected: "stripe.com",
      normalizer: "domain",
    },
    unidentifiable: { company: { domains: [] } },
  },
  "fiber.source.tracker": {
    config: { listId: "trk_openceramic", entity: "company", ruleIds: ["new_funding_round"] },
    identity: {
      items: [
        { entityType: "company", linkedinUrl: "https://www.LinkedIn.com/company/linear/", linkedinSlug: null },
        { entityType: "company", linkedinUrl: "linkedin.com/company/linear", linkedinSlug: null },
        { entityType: "company", linkedinUrl: null, linkedinSlug: "linear" },
      ],
      expected: "https://linkedin.com/company/linear",
      normalizer: "url",
    },
    unidentifiable: { entityType: "company", linkedinUrl: null, linkedinSlug: null },
  },
};

// Snapshotted at module load, before the registry tests below clear it.
const sources = list();

const ctx = () => ({
  fiber: new FakeFiberClient({ inMemory: true }),
  logger: () => {},
});

describe("source contract", () => {
  it("registers both sources, one per kind", () => {
    expect(sources.map((s) => s.id).sort()).toEqual([
      "fiber.source.savedSearch",
      "fiber.source.tracker",
    ]);
    expect(new Set(sources.map((s) => s.kind))).toEqual(new Set(["saved_search", "tracker"]));
  });

  it("has an example for every registered source", () => {
    for (const s of sources) {
      expect(EXAMPLES, `missing EXAMPLES entry for ${s.id}`).toHaveProperty(s.id);
    }
  });

  it("gives every source a unique id in the fiber.source.* namespace", () => {
    const ids = sources.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^fiber\.source\./);
  });

  it("declares a non-empty label, description and config form", () => {
    for (const s of sources) {
      expect(s.label.length, s.id).toBeGreaterThan(0);
      expect(s.description.length, s.id).toBeGreaterThan(0);
      expect(s.configFields.length, s.id).toBeGreaterThan(0);
    }
  });

  it("parses its own example config", () => {
    for (const s of sources) {
      const parsed = s.config.safeParse(EXAMPLES[s.id].config);
      expect(parsed.success, `${s.id}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it("normalizes identities consistently", () => {
    for (const s of sources) {
      const { items, expected, normalizer } = EXAMPLES[s.id].identity;

      // The expected key must itself be normalised, or the source is inventing
      // its own scheme rather than reusing src/enrichments/normalize.ts.
      const normalize = normalizer === "domain" ? normalizeDomain : normalizeUrl;
      expect(normalize(expected), `${s.id} expects an unnormalised key`).toBe(expected);

      for (const item of items) {
        expect(s.identityFor(item), `${s.id}: ${JSON.stringify(item)}`).toBe(expected);
      }
    }
  });

  it("returns null for an item it cannot identify", () => {
    for (const s of sources) {
      expect(s.identityFor(EXAMPLES[s.id].unidentifiable), s.id).toBeNull();
    }
  });

  it("returns a cursor from poll even when it finds no rows", async () => {
    for (const s of sources) {
      const config = s.config.parse(EXAMPLES[s.id].config);
      const result = await s.poll(config, {}, ctx());

      expect(Array.isArray(result.rows), s.id).toBe(true);
      // A poll that returns rows but no cursor loses its place permanently.
      expect(result.cursor, s.id).toBeTypeOf("object");
      expect(result.cursor, s.id).not.toBeNull();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

/** A source with just enough surface to register. */
function stub(overrides: Partial<AnyRowSource> = {}): AnyRowSource {
  return {
    kind: "tracker",
    id: "fiber.source.tracker",
    label: "Stub",
    description: "Stub",
    entity: "company",
    config: z.object({}),
    configFields: [{ key: "listId", label: "List", type: "string" }],
    identityFor: () => null,
    poll: async (): Promise<PollResult> => ({ rows: [], cursor: {} }),
    ...overrides,
  };
}

describe("source registry", () => {
  beforeEach(() => clear());
  afterAll(() => clear());

  it("registers and resolves a source by id", () => {
    const s = stub();
    register(s);
    expect(get("fiber.source.tracker")).toBe(s);
    expect(getOrThrow("fiber.source.tracker")).toBe(s);
    expect(list()).toEqual([s]);
  });

  it("rejects a second registration of the same id", () => {
    register(stub());
    expect(() => register(stub())).toThrow(SourceRegistryError);
  });

  it("rejects an id outside the fiber.source.* namespace", () => {
    expect(() => register(stub({ id: "tracker" }))).toThrow(/fiber\.source\./);
  });

  it("rejects a kind that disagrees with the id", () => {
    expect(() =>
      register(stub({ id: "fiber.source.savedSearch", kind: "tracker" })),
    ).toThrow(/implies "saved_search"/);
  });

  it("accepts a camelCase id whose snake_case form is the kind", () => {
    expect(() =>
      register(stub({ id: "fiber.source.savedSearch", kind: "saved_search" })),
    ).not.toThrow();
  });

  it("throws rather than returning undefined for an unknown id", () => {
    expect(() => getOrThrow("fiber.source.nope")).toThrow(SourceRegistryError);
    expect(get("fiber.source.nope")).toBeUndefined();
  });

  it("filters by entity exactly — a person source is not offered to a company table", () => {
    const company = stub();
    const person = stub({
      id: "fiber.source.savedSearch",
      kind: "saved_search",
      entity: "person",
    });
    register(company);
    register(person);

    expect(listForEntity("company")).toEqual([company]);
    expect(listForEntity("person")).toEqual([person]);
  });
});
