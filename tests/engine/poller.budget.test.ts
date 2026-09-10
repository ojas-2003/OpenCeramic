import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PlanError, type PlanResult } from "@/engine/planner";

/**
 * The unattended spend cap, tested where it actually has to hold: between
 * pricing a run and starting it. A cap enforced anywhere later is not a cap —
 * by the time the executor is running the credits are already going out.
 *
 * The database is mocked rather than used, so this stays as DB-free as the rest
 * of the poller tests.
 */

const planRun = vi.fn<(...args: unknown[]) => Promise<PlanResult>>();
const triggerRun = vi.fn<(...args: unknown[]) => Promise<void>>();
const listColumns = vi.fn<(...args: unknown[]) => Promise<unknown[]>>();

vi.mock("@/engine/planner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/engine/planner")>()),
  planRun: (...args: unknown[]) => planRun(...args),
}));

vi.mock("@/engine/trigger", () => ({
  triggerRun: (...args: unknown[]) => triggerRun(...args),
  cancelRun: vi.fn(),
}));

vi.mock("@/db/queries", () => ({
  listColumns: (...args: unknown[]) => listColumns(...args),
  getTableWithData: vi.fn(),
  upsertCells: vi.fn(),
  createRun: vi.fn(),
  getSource: vi.fn(),
  insertRowsIfNew: vi.fn(),
  listActiveSources: vi.fn(),
  updateSourceCursor: vi.fn(),
}));

const { enrichNewRows } = await import("@/engine/poller.inngest");

const plan = (estimatedCredits: number): PlanResult => ({
  runId: "run_1",
  levels: [["col_a"]],
  counts: { total: 3, cached: 0 },
  estimatedCredits,
});

const NEW_ROWS = ["row_1", "row_2", "row_3"];

beforeEach(() => {
  planRun.mockReset();
  triggerRun.mockReset();
  listColumns.mockReset();
  listColumns.mockResolvedValue([
    { id: "col_web", kind: "input" },
    { id: "col_a", kind: "enrichment" },
    { id: "col_b", kind: "enrichment" },
  ]);
  process.env.MAX_AUTO_CREDITS_PER_POLL = "200";
});

afterEach(() => {
  delete process.env.MAX_AUTO_CREDITS_PER_POLL;
});

describe("unattended spend cap", () => {
  it("starts the run when the estimate is under the cap", async () => {
    planRun.mockResolvedValue(plan(199));

    const verdict = await enrichNewRows("tbl_1", NEW_ROWS);

    expect(verdict).toEqual({ status: "active", message: null });
    expect(triggerRun).toHaveBeenCalledWith("run_1");
  });

  it("starts the run when the estimate is exactly the cap", async () => {
    planRun.mockResolvedValue(plan(200));

    await enrichNewRows("tbl_1", NEW_ROWS);

    expect(triggerRun).toHaveBeenCalledTimes(1);
  });

  it("does NOT start the run when the estimate is over the cap", async () => {
    planRun.mockResolvedValue(plan(201));

    const verdict = await enrichNewRows("tbl_1", NEW_ROWS);

    // The assertion this whole file exists for.
    expect(triggerRun).not.toHaveBeenCalled();
    expect(verdict.status).toBe("paused");
    expect(verdict.message).toContain("201");
    expect(verdict.message).toContain("200");
  });

  it("plans before it decides, so the cap is checked against a real estimate", async () => {
    planRun.mockResolvedValue(plan(5000));

    await enrichNewRows("tbl_1", NEW_ROWS);

    expect(planRun).toHaveBeenCalledTimes(1);
    expect(triggerRun).not.toHaveBeenCalled();
  });

  it("scopes the run to the new rows and every enrichment column", async () => {
    planRun.mockResolvedValue(plan(10));

    await enrichNewRows("tbl_1", NEW_ROWS);

    expect(planRun.mock.calls[0][0]).toEqual({
      tableId: "tbl_1",
      scope: "table",
      target: {
        // Never col_web: input columns do not run. Never a pre-existing row.
        column_ids: ["col_a", "col_b"],
        row_ids: NEW_ROWS,
      },
    });
  });

  it("honours a raised cap from the environment", async () => {
    process.env.MAX_AUTO_CREDITS_PER_POLL = "1000";
    planRun.mockResolvedValue(plan(900));

    const verdict = await enrichNewRows("tbl_1", NEW_ROWS);

    expect(verdict.status).toBe("active");
    expect(triggerRun).toHaveBeenCalledTimes(1);
  });

  it("falls back to a safe default when the cap is unset or nonsense", async () => {
    delete process.env.MAX_AUTO_CREDITS_PER_POLL;
    planRun.mockResolvedValue(plan(201));
    expect((await enrichNewRows("tbl_1", NEW_ROWS)).status).toBe("paused");

    process.env.MAX_AUTO_CREDITS_PER_POLL = "not-a-number";
    triggerRun.mockReset();
    expect((await enrichNewRows("tbl_1", NEW_ROWS)).status).toBe("paused");
    expect(triggerRun).not.toHaveBeenCalled();
  });

  it("does nothing at all when the table has no enrichment columns", async () => {
    listColumns.mockResolvedValue([{ id: "col_web", kind: "input" }]);

    const verdict = await enrichNewRows("tbl_1", NEW_ROWS);

    expect(verdict).toEqual({ status: "active", message: null });
    expect(planRun).not.toHaveBeenCalled();
    expect(triggerRun).not.toHaveBeenCalled();
  });

  it("pauses rather than starting anything when the per-run cap rejects the plan", async () => {
    planRun.mockRejectedValue(new PlanError("over_budget", { estimatedCredits: 9000, max: 2000 }));

    const verdict = await enrichNewRows("tbl_1", NEW_ROWS);

    expect(verdict.status).toBe("paused");
    expect(triggerRun).not.toHaveBeenCalled();
  });

  it("records a broken table as an error rather than a budget pause", async () => {
    planRun.mockRejectedValue(new PlanError("cycle", { columns: ["col_a"] }));

    const verdict = await enrichNewRows("tbl_1", NEW_ROWS);

    expect(verdict.status).toBe("error");
    expect(verdict.message).toContain("cycle");
    expect(triggerRun).not.toHaveBeenCalled();
  });
});
