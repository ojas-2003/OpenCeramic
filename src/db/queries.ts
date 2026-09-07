import { and, asc, desc, eq, getTableColumns, gt, inArray, sql } from "drizzle-orm";

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
  type NewColumn,
  type Row,
  type Run,
  type Table,
  type EntityType,
  type ColumnConfig,
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

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

export async function createTable(name: string, entityType: EntityType): Promise<Table> {
  const [table] = await db.insert(tables).values({ name, entityType }).returning();
  return table;
}

export async function listTables(): Promise<Table[]> {
  return db.select().from(tables).orderBy(desc(tables.createdAt));
}

export async function deleteTable(tableId: string): Promise<boolean> {
  const deleted = await db.delete(tables).where(eq(tables.id, tableId)).returning({ id: tables.id });
  return deleted.length > 0;
}

export async function getTable(tableId: string): Promise<Table | null> {
  const [table] = await db.select().from(tables).where(eq(tables.id, tableId));
  return table ?? null;
}

/* ------------------------------------------------------------------ */
/* Columns                                                             */
/* ------------------------------------------------------------------ */

export async function getColumn(columnId: string): Promise<Column | null> {
  const [column] = await db.select().from(columns).where(eq(columns.id, columnId));
  return column ?? null;
}

export async function listColumns(tableId: string): Promise<Column[]> {
  return db.select().from(columns).where(eq(columns.tableId, tableId)).orderBy(asc(columns.position));
}

/** Creates the column and an idle cell for every existing row, in one go. */
export async function createColumn(column: NewColumn): Promise<Column> {
  const [created] = await db.insert(columns).values(column).returning();

  const tableRows = await db
    .select({ id: rows.id })
    .from(rows)
    .where(eq(rows.tableId, created.tableId));

  if (tableRows.length > 0) {
    await upsertCells(
      tableRows.map((r) => ({ rowId: r.id, columnId: created.id, status: "idle" as const })),
    );
  }
  return created;
}

export async function updateColumn(
  columnId: string,
  patch: { name?: string; config?: ColumnConfig },
): Promise<Column | null> {
  const [updated] = await db
    .update(columns)
    .set(patch)
    .where(eq(columns.id, columnId))
    .returning();
  return updated ?? null;
}

export async function deleteColumn(columnId: string): Promise<boolean> {
  const deleted = await db
    .delete(columns)
    .where(eq(columns.id, columnId))
    .returning({ id: columns.id });
  return deleted.length > 0;
}

export async function nextColumnPosition(tableId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${columns.position}), -1)::int` })
    .from(columns)
    .where(eq(columns.tableId, tableId));
  return (row?.max ?? -1) + 1;
}

/* ------------------------------------------------------------------ */
/* Rows                                                               */
/* ------------------------------------------------------------------ */

/**
 * Appends rows. Input columns get a done cell carrying the supplied text;
 * enrichment columns get an idle cell so the grid has something to render.
 */
export async function createRows(
  tableId: string,
  incoming: Array<Record<string, string>>,
): Promise<Row[]> {
  if (incoming.length === 0) return [];

  const tableColumns = await listColumns(tableId);
  const [maxRow] = await db
    .select({ max: sql<number>`coalesce(max(${rows.position}), -1)::int` })
    .from(rows)
    .where(eq(rows.tableId, tableId));
  const start = (maxRow?.max ?? -1) + 1;

  const created = await db
    .insert(rows)
    .values(incoming.map((_, i) => ({ tableId, position: start + i })))
    .returning();

  const values: NewCell[] = [];
  for (const [i, row] of created.entries()) {
    for (const column of tableColumns) {
      if (column.kind === "input") {
        const raw = incoming[i][column.name];
        values.push({
          rowId: row.id,
          columnId: column.id,
          status: "done",
          value: raw === undefined ? null : raw,
        });
      } else {
        values.push({ rowId: row.id, columnId: column.id, status: "idle" });
      }
    }
  }
  await upsertCells(values);

  return created;
}

/* ------------------------------------------------------------------ */
/* Run polling                                                         */
/* ------------------------------------------------------------------ */

/** Cells this run touched since `since` — the diff the grid polls for. */
export async function getCellsForRunSince(runId: string, since: Date | null): Promise<Cell[]> {
  const where = since
    ? and(eq(cells.runId, runId), gt(cells.updatedAt, since))
    : eq(cells.runId, runId);
  return db.select().from(cells).where(where);
}
