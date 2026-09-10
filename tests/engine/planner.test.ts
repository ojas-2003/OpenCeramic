import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { Cell, Column, NewCell, NewRun, Row, Run, Table } from "@/db/schema";
import type { TableWithData } from "@/db/queries";
import {
  downstreamOf,
  edgesFromColumns,
  PlanError,
  planRun,
  topoSortLevels,
  type Edge,
  type PlanDeps,
} from "@/engine/planner";
import type { AnyEnrichment } from "@/enrichments/types";

/* ------------------------------------------------------------------ */
/* Pure functions — no database                                        */
/* ------------------------------------------------------------------ */

describe("topoSortLevels", () => {
  it("orders a linear chain one column per level", () => {
    const edges: Edge[] = [
      ["A", "B"],
      ["B", "C"],
    ];
    expect(topoSortLevels(edges, ["A", "B", "C"])).toEqual([["A"], ["B"], ["C"]]);
  });

  it("runs independent branches of a diamond in the same level", () => {
    const edges: Edge[] = [
      ["A", "B"],
      ["A", "C"],
      ["B", "D"],
      ["C", "D"],
    ];
    expect(topoSortLevels(edges, ["A", "B", "C", "D"])).toEqual([["A"], ["B", "C"], ["D"]]);
  });

  it("puts wholly independent columns in a single level", () => {
    expect(topoSortLevels([], ["A", "B", "C"])).toEqual([["A", "B", "C"]]);
  });

  it("throws on a cycle, naming the columns involved", () => {
    const edges: Edge[] = [
      ["A", "B"],
      ["B", "C"],
      ["C", "A"],
    ];
    const err = (() => {
      try {
        topoSortLevels(edges, ["A", "B", "C"]);
      } catch (e) {
        return e as PlanError;
      }
    })();

    expect(err).toBeInstanceOf(PlanError);
    expect(err!.code).toBe("cycle");
    expect(err!.details.columns).toEqual(["A", "B", "C"]);
  });

  it("throws on a self-edge", () => {
    expect(() => topoSortLevels([["A", "A"]], ["A"])).toThrow(PlanError);
  });

  it("ignores edges from columns outside the run, such as input columns", () => {
    // "Website" feeds B but is never itself run.
    const edges: Edge[] = [
      ["Website", "B"],
      ["B", "C"],
    ];
    expect(topoSortLevels(edges, ["B", "C"])).toEqual([["B"], ["C"]]);
  });

  it("does not double-count a duplicated edge", () => {
    const edges: Edge[] = [
      ["A", "B"],
      ["A", "B"],
    ];
    expect(topoSortLevels(edges, ["A", "B"])).toEqual([["A"], ["B"]]);
  });

  it("is deterministic in the order given by nodes", () => {
    const edges: Edge[] = [
      ["A", "C"],
      ["B", "C"],
    ];
    expect(topoSortLevels(edges, ["B", "A", "C"])).toEqual([["B", "A"], ["C"]]);
  });
});

describe("downstreamOf", () => {
  const chain: Edge[] = [
    ["A", "B"],
    ["B", "C"],
    ["C", "D"],
  ];

  it("returns transitive dependents, excluding the seeds", () => {
    expect(downstreamOf(chain, ["B"]).sort()).toEqual(["C", "D"]);
  });

  it("returns nothing for a leaf", () => {
    expect(downstreamOf(chain, ["D"])).toEqual([]);
  });

  it("follows both arms of a diamond", () => {
    const diamond: Edge[] = [
      ["A", "B"],
      ["A", "C"],
      ["B", "D"],
      ["C", "D"],
    ];
    expect(downstreamOf(diamond, ["A"]).sort()).toEqual(["B", "C", "D"]);
  });

  it("terminates on a cycle instead of looping forever", () => {
    const cyclic: Edge[] = [
      ["A", "B"],
      ["B", "A"],
    ];
    expect(downstreamOf(cyclic, ["A"]).sort()).toEqual(["B"]);
  });
});

describe("edgesFromColumns", () => {
  it("reads config.inputs as source -> dependent", () => {
    expect(
      edgesFromColumns([
        { id: "B", config: { inputs: { domain: "A" } } },
        { id: "C", config: { inputs: { url: "B", extra: "A" } } },
        { id: "A", config: { inputs: {} } },
      ]),
    ).toEqual([
      ["A", "B"],
      ["B", "C"],
      ["A", "C"],
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* planRun — in-memory stub of the queries module                      */
/* ------------------------------------------------------------------ */

const CREDITS_PER_CALL = 2;

function makeAdapter(id: string): AnyEnrichment {
  const schema = z.record(z.string(), z.unknown());
  return {
    id,
    version: 1,
    label: id,
    description: id,
    entity: "company",
    mode: "sync",
    inputs: schema,
    output: schema,
    outputFields: [],
    estimateCredits: () => CREDITS_PER_CALL,
    cacheKey: (input) => `${id}:1:${JSON.stringify(input)}`,
    run: async () => ({}),
  };
}

const column = (
  id: string,
  kind: "input" | "enrichment",
  position: number,
  inputs: Record<string, string> = {},
): Column => ({
  id,
  tableId: "t1",
  name: id,
  kind,
  enrichmentId: kind === "enrichment" ? `fiber.test.${id}` : null,
  enrichmentVersion: kind === "enrichment" ? 1 : null,
  config: { inputs },
  position,
  createdAt: new Date(),
});

const cell = (
  rowId: string,
  columnId: string,
  status: Cell["status"],
  value: unknown = null,
): Cell => ({
  rowId,
  columnId,
  value,
  status,
  errorCode: null,
  errorMessage: null,
  runId: null,
  provenance: null,
  updatedAt: new Date(),
});

/** Website -> A -> B -> C -> D, two rows, website cells already done. */
function fixture(extraCells: Cell[] = []): TableWithData {
  const columns: Column[] = [
    column("W", "input", 0),
    column("A", "enrichment", 1, { domain: "W" }),
    column("B", "enrichment", 2, { x: "A" }),
    column("C", "enrichment", 3, { x: "B" }),
    column("D", "enrichment", 4, { x: "C" }),
  ];
  // Uploaded rows: no source, so no identity key and no signal.
  const rows: Row[] = [
    { id: "r1", tableId: "t1", position: 0, createdAt: new Date(), sourceId: null, identityKey: null, signal: null },
    { id: "r2", tableId: "t1", position: 1, createdAt: new Date(), sourceId: null, identityKey: null, signal: null },
  ];
  const cells: Cell[] = [
    cell("r1", "W", "done", "acme.com"),
    cell("r2", "W", "done", "globex.com"),
    ...extraCells,
  ];
  return {
    table: { id: "t1", name: "t", entityType: "company", createdAt: new Date() } as Table,
    columns,
    rows,
    cells,
  };
}

function makeDeps(data: TableWithData, cachedKeys: string[] = []) {
  const upserted: NewCell[] = [];
  const created: NewRun[] = [];
  const lookedUp: string[][] = [];

  const deps: PlanDeps = {
    db: {
      getTableWithData: async () => data,
      upsertCells: async (values) => {
        upserted.push(...values);
      },
      createRun: async (run) => {
        created.push(run);
        return run as Run;
      },
    },
    registry: {
      get: (id) => (id.startsWith("fiber.test.") ? makeAdapter(id) : undefined),
    },
    cacheLookup: async (keys) => {
      lookedUp.push(keys);
      return new Set(keys.filter((k) => cachedKeys.includes(k)));
    },
  };

  return { deps, upserted, created, lookedUp };
}

describe("planRun", () => {
  const originalMax = process.env.MAX_CREDITS_PER_RUN;

  beforeEach(() => {
    process.env.MAX_CREDITS_PER_RUN = originalMax ?? "2000";
  });

  it("plans every enrichment column for scope=table, never an input column", async () => {
    const { deps, upserted, created } = makeDeps(fixture());

    const result = await planRun(
      { tableId: "t1", scope: "table", target: { column_ids: [] } },
      deps,
    );

    expect(result.levels).toEqual([["A"], ["B"], ["C"], ["D"]]);
    expect(result.counts.total).toBe(8); // 4 enrichment columns x 2 rows
    expect(upserted).toHaveLength(8);
    expect(upserted.every((c) => c.columnId !== "W")).toBe(true);
    expect(upserted.every((c) => c.status === "pending" && c.runId === result.runId)).toBe(true);
    expect(created[0].plan).toEqual({ levels: [["A"], ["B"], ["C"], ["D"]] });
    expect(created[0].status).toBe("planned");
  });

  it("column scope on B includes C and D but not A", async () => {
    const { deps, upserted } = makeDeps(fixture());

    const result = await planRun(
      { tableId: "t1", scope: "column", target: { column_ids: ["B"] } },
      deps,
    );

    expect(result.levels).toEqual([["B"], ["C"], ["D"]]);
    expect([...new Set(upserted.map((c) => c.columnId))].sort()).toEqual(["B", "C", "D"]);
  });

  it("restricts to the given rows for scope=cell", async () => {
    const { deps, upserted } = makeDeps(fixture());

    const result = await planRun(
      { tableId: "t1", scope: "cell", target: { column_ids: ["D"], row_ids: ["r2"] } },
      deps,
    );

    expect(result.counts.total).toBe(1);
    expect(upserted[0]).toMatchObject({ rowId: "r2", columnId: "D" });
  });

  it("leaves done cells untouched by default", async () => {
    const { deps, upserted } = makeDeps(fixture([cell("r1", "A", "done", { v: 1 })]));

    const result = await planRun(
      { tableId: "t1", scope: "table", target: { column_ids: [] } },
      deps,
    );

    expect(result.counts.total).toBe(7);
    expect(upserted.some((c) => c.rowId === "r1" && c.columnId === "A")).toBe(false);
  });

  it("resets done cells when force is set", async () => {
    const { deps, upserted } = makeDeps(fixture([cell("r1", "A", "done", { v: 1 })]));

    const result = await planRun(
      { tableId: "t1", scope: "table", target: { column_ids: [] }, force: true },
      deps,
    );

    expect(result.counts.total).toBe(8);
    const forced = upserted.find((c) => c.rowId === "r1" && c.columnId === "A")!;
    expect(forced.status).toBe("pending");
  });

  it("clears error fields but preserves the previous value", async () => {
    const failed: Cell = {
      ...cell("r1", "A", "failed"),
      value: { stale: true },
      errorCode: "boom",
      errorMessage: "it broke",
      provenance: { credits: 9 },
    };
    const { deps, upserted } = makeDeps(fixture([failed]));

    await planRun({ tableId: "t1", scope: "table", target: { column_ids: [] } }, deps);

    const replanned = upserted.find((c) => c.rowId === "r1" && c.columnId === "A")!;
    expect(replanned.errorCode).toBeNull();
    expect(replanned.errorMessage).toBeNull();
    expect(replanned.provenance).toBeNull();
    expect(replanned.value).toEqual({ stale: true });
  });

  it("excludes cached keys from the estimate and counts them", async () => {
    const data = fixture();
    // Only column A's inputs resolve now (W is done); everything downstream is
    // waiting on upstream and is priced as a miss.
    const cachedKey = makeAdapter("fiber.test.A").cacheKey({ domain: "acme.com" });
    const { deps, lookedUp } = makeDeps(data, [cachedKey]);

    const result = await planRun(
      { tableId: "t1", scope: "table", target: { column_ids: [] } },
      deps,
    );

    expect(result.counts.cached).toBe(1);
    expect(result.estimatedCredits).toBe(7 * CREDITS_PER_CALL);
    // One cache round trip for the whole run.
    expect(lookedUp).toHaveLength(1);
    expect(lookedUp[0]).toContain(cachedKey);
  });

  it("prices cells with unresolvable inputs as a cache miss", async () => {
    const { deps, lookedUp } = makeDeps(fixture());
    await planRun({ tableId: "t1", scope: "table", target: { column_ids: [] } }, deps);
    // Only A's two cells can be keyed; B, C and D are waiting on upstream.
    expect(lookedUp[0]).toHaveLength(2);
  });

  it("throws over_budget with the numbers, and writes nothing", async () => {
    process.env.MAX_CREDITS_PER_RUN = "10";
    const { deps, upserted, created } = makeDeps(fixture());

    const err = await planRun(
      { tableId: "t1", scope: "table", target: { column_ids: [] } },
      deps,
    ).catch((e: unknown) => e as PlanError);

    expect(err).toBeInstanceOf(PlanError);
    expect((err as PlanError).code).toBe("over_budget");
    expect((err as PlanError).details).toEqual({ estimatedCredits: 16, max: 10 });
    // The plan was refused before any state changed.
    expect(upserted).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  it("throws on a cycle before writing anything", async () => {
    const data = fixture();
    // D feeds A, closing the loop A -> B -> C -> D -> A.
    data.columns[1].config = { inputs: { x: "D" } };
    const { deps, upserted, created } = makeDeps(data);

    const err = await planRun(
      { tableId: "t1", scope: "table", target: { column_ids: [] } },
      deps,
    ).catch((e: unknown) => e as PlanError);

    expect((err as PlanError).code).toBe("cycle");
    expect(upserted).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  it("throws when a column references an unregistered adapter", async () => {
    const data = fixture();
    data.columns[1].enrichmentId = "fiber.missing.adapter";
    const { deps, created } = makeDeps(data);

    const err = await planRun(
      { tableId: "t1", scope: "table", target: { column_ids: [] } },
      deps,
    ).catch((e: unknown) => e as PlanError);

    expect((err as PlanError).code).toBe("unknown_enrichment");
    expect(created).toHaveLength(0);
  });

  it("throws when the table does not exist", async () => {
    const { deps } = makeDeps(fixture());
    deps.db.getTableWithData = async () => null;

    const err = await planRun(
      { tableId: "nope", scope: "table", target: { column_ids: [] } },
      deps,
    ).catch((e: unknown) => e as PlanError);

    expect((err as PlanError).code).toBe("table_not_found");
  });

  it("throws when a targeted column is not in the table", async () => {
    const { deps } = makeDeps(fixture());

    const err = await planRun(
      { tableId: "t1", scope: "column", target: { column_ids: ["ghost"] } },
      deps,
    ).catch((e: unknown) => e as PlanError);

    expect((err as PlanError).code).toBe("unknown_column");
  });
});
