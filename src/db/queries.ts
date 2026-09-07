import { and, asc, eq, getTableColumns, inArray, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  apiCalls,
  cells,
  columns,
  rows,
  runs,
  tables,
  type Cell,
  type Column,
  type NewCell,
  type NewRun,
  type Row,
  type Run,
  type Table,
} from "@/db/schema";

export type TableWithData = {
  table: Table;
  columns: Column[];
  rows: Row[];
  cells: Cell[];
};

/**
 * Everything the grid needs for one table. Cells come back as a flat array;
 * the client indexes them by (row_id, column_id).
 */
export async function getTableWithData(
  tableId: string,
): Promise<TableWithData | null> {
  const [table] = await db.select().from(tables).where(eq(tables.id, tableId));
  if (!table) return null;

  const [tableColumns, tableRows, tableCells] = await Promise.all([
    db
      .select()
      .from(columns)
      .where(eq(columns.tableId, tableId))
      .orderBy(asc(columns.position)),
    db
      .select()
      .from(rows)
      .where(eq(rows.tableId, tableId))
      .orderBy(asc(rows.position)),
    db
      .select(getTableColumns(cells))
      .from(cells)
      .innerJoin(rows, eq(cells.rowId, rows.id))
      .where(eq(rows.tableId, tableId)),
  ]);

  return { table, columns: tableColumns, rows: tableRows, cells: tableCells };
}

/**
 * Postgres caps a statement at 65535 bound parameters. A cell carries 9
 * columns, so 500 rows per statement leaves plenty of headroom while still
 * letting callers hand us an entire run's worth of cells in one go.
 */
const UPSERT_CHUNK_SIZE = 500;

/**
 * The only way cells are written. Upserting on (row_id, column_id) is what
 * makes a redelivered Inngest step harmless — see CLAUDE.md.
 */
export async function upsertCells(values: NewCell[]): Promise<void> {
  if (values.length === 0) return;

  for (let i = 0; i < values.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = values.slice(i, i + UPSERT_CHUNK_SIZE);
    await db
      .insert(cells)
      .values(chunk)
      .onConflictDoUpdate({
        target: [cells.rowId, cells.columnId],
        set: {
          value: sql`excluded.value`,
          status: sql`excluded.status`,
          errorCode: sql`excluded.error_code`,
          errorMessage: sql`excluded.error_message`,
          runId: sql`excluded.run_id`,
          provenance: sql`excluded.provenance`,
          updatedAt: sql`now()`,
        },
      });
  }
}

/** The planner supplies the id so cells can reference the run as they are written. */
export async function createRun(run: NewRun): Promise<Run> {
  const [created] = await db.insert(runs).values(run).returning();
  return created;
}

export type RunPatch = Partial<Omit<NewRun, "id" | "tableId" | "createdAt">>;

export async function updateRun(
  runId: string,
  patch: RunPatch,
): Promise<Run | null> {
  const [updated] = await db
    .update(runs)
    .set(patch)
    .where(eq(runs.id, runId))
    .returning();
  return updated ?? null;
}

/** The work list for one column within one run. */
export async function getPendingCells(
  runId: string,
  columnId: string,
): Promise<Cell[]> {
  return db
    .select()
    .from(cells)
    .where(
      and(
        eq(cells.runId, runId),
        eq(cells.columnId, columnId),
        eq(cells.status, "pending"),
      ),
    );
}

/** The executor loads the run it was handed by the event. */
export async function getRun(runId: string): Promise<Run | null> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  return run ?? null;
}

/** Every cell this run touched, for finalisation and for the polling endpoint. */
export async function getCellsForRun(runId: string): Promise<Cell[]> {
  return db.select().from(cells).where(eq(cells.runId, runId));
}

/**
 * What the run actually cost: the credits recorded against the api_calls rows
 * that the run's cells point at. Summing provenance directly would double-count
 * a cell that was written more than once.
 */
export async function sumCreditsForApiCalls(apiCallIds: string[]): Promise<number> {
  if (apiCallIds.length === 0) return 0;
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${apiCalls.credits}), 0)::int` })
    .from(apiCalls)
    .where(inArray(apiCalls.id, apiCallIds));
  return row?.total ?? 0;
}
