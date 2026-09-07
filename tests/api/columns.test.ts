import { describe, expect, it } from "vitest";

import type { ColumnConfig } from "@/db/schema";
import "@/enrichments";
import { get as getEnrichment } from "@/enrichments/registry";
import { adapterInputKeys, validateColumn, type ColumnLike } from "@/lib/validateColumn";

/**
 * Column validation is pure, so these run with no database and no HTTP server.
 * The route is a thin shell around validateColumn().
 */

const WEBSITE: ColumnLike = { id: "col-website", kind: "input", config: { inputs: {} } };
const COMPANY: ColumnLike = {
  id: "col-company",
  kind: "enrichment",
  config: { inputs: { domain: "col-website" } },
};
const PERSON: ColumnLike = {
  id: "col-person",
  kind: "enrichment",
  config: { inputs: { company_linkedin_url: "col-company" } },
};

const base = (over: Partial<Parameters<typeof validateColumn>[0]> = {}) => ({
  tableEntity: "company" as const,
  existing: [WEBSITE, COMPANY, PERSON],
  adapter: getEnrichment("fiber.company.revenue"),
  config: { inputs: { linkedin_url: "col-company" } } as ColumnConfig,
  ...over,
});

describe("validateColumn", () => {
  it("accepts a well-formed mapping", () => {
    expect(validateColumn(base())).toBeNull();
  });

  it("rejects an enrichment that is not registered", () => {
    const result = validateColumn(base({ adapter: getEnrichment("fiber.nope.missing") }));
    expect(result?.code).toBe("unknown_enrichment");
    expect(result?.status).toBe(400);
  });

  it("rejects an adapter whose entity does not match the table", () => {
    // fiber.company.revenue is a company adapter; this table holds people.
    const result = validateColumn(base({ tableEntity: "person" }));
    expect(result?.code).toBe("entity_mismatch");
    expect(result?.message).toContain("company");
  });

  it("accepts an entity:any adapter on any table", () => {
    const result = validateColumn(
      base({
        tableEntity: "person",
        adapter: getEnrichment("fiber.email.validate"),
        config: { inputs: { email: "col-website" } },
      }),
    );
    expect(result).toBeNull();
  });

  it("rejects a required input that is not mapped", () => {
    const result = validateColumn(base({ config: { inputs: {} } }));
    expect(result?.code).toBe("unmapped_input");
    expect(result?.details?.missing).toEqual(["linkedin_url"]);
  });

  it("requires at least one mapping even when every input is optional", () => {
    // kitchenSink takes domain OR name; both are optional individually.
    const result = validateColumn(
      base({ adapter: getEnrichment("fiber.company.kitchenSink"), config: { inputs: {} } }),
    );
    expect(result?.code).toBe("unmapped_input");
    expect(result?.details?.expected).toEqual(expect.arrayContaining(["domain", "name"]));
  });

  it("accepts an optional-only adapter when one input is mapped", () => {
    const result = validateColumn(
      base({
        adapter: getEnrichment("fiber.company.kitchenSink"),
        config: { inputs: { domain: "col-website" } },
      }),
    );
    expect(result).toBeNull();
  });

  it("does not require an input that has a default", () => {
    // title_query defaults to "CEO OR Founder", so it need not be mapped.
    const result = validateColumn(
      base({
        adapter: getEnrichment("fiber.people.findAtCompany"),
        config: { inputs: { company_linkedin_url: "col-company" } },
      }),
    );
    expect(result).toBeNull();
  });

  it("rejects an input key the adapter does not declare", () => {
    const result = validateColumn(base({ config: { inputs: { nonsense: "col-company" } } }));
    expect(result?.code).toBe("unknown_input");
  });

  it("rejects a source column that is not in this table", () => {
    const result = validateColumn(base({ config: { inputs: { linkedin_url: "col-elsewhere" } } }));
    expect(result?.code).toBe("unknown_source_column");
  });

  it("rejects a column that maps to itself", () => {
    const result = validateColumn(
      base({ columnId: "col-company", config: { inputs: { linkedin_url: "col-company" } } }),
    );
    expect(result?.code).toBe("cycle");
  });

  it("rejects a mapping that would close a loop", () => {
    // col-company already feeds col-person. Editing col-company to read from
    // col-person closes company -> person -> company.
    const result = validateColumn(
      base({
        adapter: getEnrichment("fiber.company.revenue"),
        columnId: "col-company",
        config: { inputs: { linkedin_url: "col-person" } },
      }),
    );
    expect(result?.code).toBe("cycle");
    expect(result?.status).toBe(400);
  });

  it("allows a diamond, which is not a cycle", () => {
    const result = validateColumn(
      base({
        adapter: getEnrichment("fiber.company.revenue"),
        config: { inputs: { linkedin_url: "col-company" } },
      }),
    );
    expect(result).toBeNull();
  });

  it("reads the column id from the dotted source form Step 10 introduces", () => {
    const result = validateColumn(
      base({ config: { inputs: { linkedin_url: "col-company.linkedin_url" } } }),
    );
    expect(result).toBeNull();
  });
});

describe("adapterInputKeys", () => {
  it("marks required and optional inputs for the add-column picker", () => {
    expect(adapterInputKeys(getEnrichment("fiber.people.findAtCompany")!)).toEqual([
      { key: "company_linkedin_url", required: true, accepts: ["string"] },
      { key: "title_query", required: false, accepts: ["string"] },
    ]);
  });

  it("marks every kitchenSink input optional, since it takes domain or name", () => {
    expect(adapterInputKeys(getEnrichment("fiber.company.kitchenSink")!)).toEqual([
      { key: "domain", required: false, accepts: ["string"] },
      { key: "name", required: false, accepts: ["string"] },
    ]);
  });
});
