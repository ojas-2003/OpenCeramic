import type { Cell, CellProvenance, Column, NewCell } from "@/db/schema";
import {
  getCellsForRun,
  getPendingCells,
  getRun,
  getTableWithData,
  sumCreditsForApiCalls,
  updateRun,
  upsertCells,
} from "@/db/queries";
import { createDbCache } from "@/engine/cache";
import {
  chunk,
  countCells,
  DEFAULT_BATCH_SIZE,
  processWork,
  resolveCells,
  SYNC_CHUNK_SIZE,
  type CellOutcome,
  type CellWork,
} from "@/engine/process";
import { getOrThrow } from "@/enrichments/registry";
import "@/enrichments"; // importing registers every adapter
import { getFiberClient } from "@/fiber";
import { inngest } from "@/inngest/client";

/**
 * The durable-execution wrapper. All the interesting logic lives in
 * src/engine/process.ts as pure functions; this file loads cells, dispatches,
 * writes results and finalises the run.
 *
 * Levels run in sequence because each one consumes what the previous produced.
 * Columns inside a level run together because the planner proved they are
 * independent.
 */

/** The slice of Inngest's step API this file uses. */
interface StepLike {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
  sleep(id: string, duration: string): Promise<unknown>;
}

type Log = (msg: string, meta?: object) => void;

export const executeRun = inngest.createFunction(
  {
    id: "execute-run",
    triggers: [{ event: "run/requested" }],
    // Step-level infrastructure failures only; a cell's error never reaches here.
    retries: 2,
    // Several concurrent runs must not stampede Fiber.
    concurrency: { limit: 3 },
    cancelOn: [{ event: "run/cancelled", if: "event.data.runId == async.data.runId" }],
  },
  async ({ event, step, logger }) => {
    const runId = String((event.data as { runId?: unknown }).runId);
    const log: Log = (msg, meta) => logger.info(msg, meta ?? {});
    const s = step as unknown as StepLike;

    const loaded = await s.run("load", async () => {
      const run = await getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);

      const data = await getTableWithData(run.tableId);
      if (!data) throw new Error(`Table ${run.tableId} not found`);

      await updateRun(runId, { status: "running" });
      return { tableId: run.tableId, levels: run.plan.levels ?? [], columns: data.columns };
    });

    const columnById = new Map<string, Column>(loaded.columns.map((c) => [c.id, c]));

    for (const level of loaded.levels) {
      await Promise.all(
        level.map((columnId) =>
          runColumn({ runId, tableId: loaded.tableId, columnId, columnById, step: s, log }),
        ),
      );
    }

    return s.run("finalize", () => finalizeRun(runId));
  },
);

/* ------------------------------------------------------------------ */

async function runColumn(args: {
  runId: string;
  tableId: string;
  columnId: string;
  columnById: Map<string, Column>;
  step: StepLike;
  log: Log;
}): Promise<void> {
  const { runId, tableId, columnId, step, log } = args;
  const column = args.columnById.get(columnId);
  if (!column?.enrichmentId) return;

  const adapter = getOrThrow(column.enrichmentId);

  // Resolve inputs. Cells that cannot run are written here and excluded.
  const runnable: CellWork[] = await step.run(`resolve-${columnId}`, async () => {
    const pending = await getPendingCells(runId, columnId);
    if (pending.length === 0) return [];

    // Re-read the table: the previous level has just written its values.
    const data = await getTableWithData(tableId);
    const sourceCells = new Map<string, Cell>(
      (data?.cells ?? []).map((c) => [`${c.rowId}:${c.columnId}`, c]),
    );

    const resolved = resolveCells(pending, column.config, adapter, sourceCells);
    if (resolved.blocked.length > 0) await writeOutcomes(runId, resolved.blocked);
    return resolved.runnable;
  });

  if (runnable.length === 0) return;

  const deps = { fiber: getFiberClient(), cache: createDbCache(), logger: log };

  if (adapter.mode === "async") {
    // start() and each poll become their own durable steps, so a poll loop
    // survives a redeploy without restarting the Fiber job.
    const outcomes = await processWork(runnable, adapter, {
      ...deps,
      runStep: <T,>(id: string, fn: () => Promise<T>) => step.run(id, fn),
      wait: async (id: string, ms: number) => {
        await step.sleep(id, `${ms}ms`);
      },
    });
    await step.run(`write-${columnId}`, async () => {
      await writeOutcomes(runId, outcomes);
      return outcomes.length;
    });
    return;
  }

  // Chunking matters: Inngest caps steps per run, and one step per cell would
  // blow that on a 200-row by 4-column table.
  const size = adapter.mode === "batch" ? (adapter.batchSize ?? DEFAULT_BATCH_SIZE) : SYNC_CHUNK_SIZE;

  for (const [n, group] of chunk(runnable, size).entries()) {
    await step.run(`exec-${columnId}-${n}`, async () => {
      const outcomes = await processWork(group, adapter, deps);
      await writeOutcomes(runId, outcomes);
      return outcomes.length;
    });
  }
}

/** Every cell write is an upsert on (row_id, column_id) — see CLAUDE.md. */
async function writeOutcomes(runId: string, outcomes: CellOutcome[]): Promise<void> {
  if (outcomes.length === 0) return;
  const values: NewCell[] = outcomes.map((o) => ({
    rowId: o.rowId,
    columnId: o.columnId,
    status: o.status,
    value: o.value ?? null,
    errorCode: o.errorCode,
    errorMessage: o.errorMessage,
    provenance: o.provenance,
    runId,
  }));
  await upsertCells(values);
}

export async function finalizeRun(runId: string) {
  const cells = await getCellsForRun(runId);
  const counts = countCells(cells);

  // Sum the api_calls rows the cells point at rather than the provenance
  // numbers directly, so a cell written twice is not counted twice.
  const apiCallIds = [
    ...new Set(
      cells
        .map((c) => (c.provenance as CellProvenance | null)?.api_call_id)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  const actualCredits = await sumCreditsForApiCalls(apiCallIds);

  // Partial failure is a successful run with failed cells; only a run where
  // nothing succeeded is itself failed.
  const status = counts.total > 0 && counts.failed === counts.total ? "failed" : "done";

  await updateRun(runId, { status, counts, actualCredits, finishedAt: new Date() });
  return { runId, status, counts, actualCredits };
}

export { countCells } from "@/engine/process";
