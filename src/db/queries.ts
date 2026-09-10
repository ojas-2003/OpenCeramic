import { and, asc, desc, eq, getTableColumns, gt, inArray, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  apiCalls,
  cells,
  columns,
  rowSources,
  rows,
  runs,
  tables,
  type Cell,
  type Column,
  type NewCell,
  type NewRun,
  type NewColumn,
  type NewRowSourceRecord,
  type Row,
  type RowSignal,
  type RowSourceRecord,
  type Run,
  type SourceCursor,
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
      // id breaks a position tie. Two inserts racing can still land on the same
      // position (see nextRowPosition), and without a tiebreak the grid would
      // reorder those rows between page loads.
      .orderBy(asc(rows.position), asc(rows.id)),
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

/**
 * The table's most recent run. The grid uses it to adopt a run it did not
 * start — a poller-triggered enrichment is watched by the same loop as one a
 * human confirmed, rather than sitting there stale until the page reloads.
 */
export async function latestRunForTable(tableId: string): Promise<Run | null> {
  const [run] = await db
    .select()
    .from(runs)
    .where(eq(runs.tableId, tableId))
    .orderBy(desc(runs.createdAt))
    .limit(1);
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
 * The append position for the nth row of an insert, computed inside the INSERT
 * itself rather than by a SELECT beforehand.
 *
 * Reading the max in a separate statement leaves a whole network round trip
 * between the read and the write, and Neon's HTTP driver has no interactive
 * transactions to close it with. Folding the subquery into the statement shrinks
 * that window to the statement's own execution. It does not vanish — two
 * statements genuinely in flight together still read the same snapshot — which
 * is why getTableWithData orders by (position, id) rather than trusting
 * positions to be unique.
 */
function nextRowPosition(tableId: string, offset: number) {
  return sql<number>`(select coalesce(max(${rows.position}), -1) from ${rows} where ${rows.tableId} = ${tableId}) + ${offset}`;
}

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

  const created = await db
    .insert(rows)
    .values(incoming.map((_, i) => ({ tableId, position: nextRowPosition(tableId, i + 1) })))
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

/* ------------------------------------------------------------------ */
/* Row sources                                                         */
/* ------------------------------------------------------------------ */

/** The poller's work list. Never-polled sources sort first. */
export async function listActiveSources(): Promise<RowSourceRecord[]> {
  return db
    .select()
    .from(rowSources)
    .where(eq(rowSources.status, "active"))
    .orderBy(sql`${rowSources.lastPolledAt} asc nulls first`);
}

export async function getSource(id: string): Promise<RowSourceRecord | null> {
  const [source] = await db.select().from(rowSources).where(eq(rowSources.id, id));
  return source ?? null;
}

/** One source plus the row count the UI shows beside it. */
export type SourceWithCount = RowSourceRecord & { rowCount: number };

export async function listSourcesForTable(tableId: string): Promise<SourceWithCount[]> {
  const found = await db
    .select({
      source: rowSources,
      rowCount: sql<number>`count(${rows.id})::int`,
    })
    .from(rowSources)
    .leftJoin(rows, eq(rows.sourceId, rowSources.id))
    .where(eq(rowSources.tableId, tableId))
    .groupBy(rowSources.id)
    .orderBy(asc(rowSources.createdAt));

  return found.map((r) => ({ ...r.source, rowCount: r.rowCount }));
}

export async function createSource(source: NewRowSourceRecord): Promise<RowSourceRecord> {
  const [created] = await db.insert(rowSources).values(source).returning();
  return created;
}

export async function updateSource(
  id: string,
  patch: SourcePatch,
): Promise<RowSourceRecord | null> {
  const [updated] = await db
    .update(rowSources)
    .set(patch)
    .where(eq(rowSources.id, id))
    .returning();
  return updated ?? null;
}

export async function deleteSource(id: string): Promise<boolean> {
  const deleted = await db
    .delete(rowSources)
    .where(eq(rowSources.id, id))
    .returning({ id: rowSources.id });
  return deleted.length > 0;
}

export type SourcePatch = Partial<
  Pick<
    NewRowSourceRecord,
    "name" | "config" | "status" | "autoEnrich" | "errorMessage" | "lastPolledAt"
  >
>;

/**
 * The only write that moves a cursor. The cursor is a separate argument rather
 * than part of the patch so that every caller has to say what it is writing —
 * a failed poll passes the cursor it was given back unchanged, which is what
 * stops a bad poll from skipping past rows it never saw.
 */
export async function updateSourceCursor(
  id: string,
  cursor: SourceCursor,
  patch: SourcePatch = {},
): Promise<RowSourceRecord | null> {
  const [updated] = await db
    .update(rowSources)
    .set({ ...patch, cursor })
    .where(eq(rowSources.id, id))
    .returning();
  return updated ?? null;
}

/** One entity a source discovered, before it is known to be new. */
export type IncomingRow = {
  identityKey: string;
  values: Record<string, string>;
  signal?: RowSignal;
};

/**
 * Appends the rows a source discovered, skipping any whose identity the table
 * already holds, and returns only the ones actually inserted. Cells follow the
 * same rule as createRows: input columns get a done cell carrying the supplied
 * text, enrichment columns get an idle cell for the run to pick up.
 */
export async function insertRowsIfNew(
  tableId: string,
  sourceId: string,
  items: IncomingRow[],
): Promise<Row[]> {
  if (items.length === 0) return [];

  // ON CONFLICT cannot see rows inserted by its own statement, so two items
  // sharing an identity in one poll would still both land. Collapse them here.
  const byIdentity = new Map<string, IncomingRow>();
  for (const item of items) {
    if (item.identityKey && !byIdentity.has(item.identityKey)) {
      byIdentity.set(item.identityKey, item);
    }
  }
  if (byIdentity.size === 0) return [];

  const tableColumns = await listColumns(tableId);

  const inserted = await db
    .insert(rows)
    .values(
      [...byIdentity.values()].map((item, i) => ({
        tableId,
        sourceId,
        position: nextRowPosition(tableId, i + 1),
        identityKey: item.identityKey,
        signal: item.signal ?? null,
      })),
    )
    // rows_table_identity_idx is partial, so Postgres needs the predicate
    // repeated here to infer it — on DO NOTHING, `where` is that predicate.
    // Without it the statement raises rather than silently skipping dedupe.
    .onConflictDoNothing({
      target: [rows.tableId, rows.identityKey],
      where: sql`${rows.identityKey} is not null`,
    })
    .returning();

  if (inserted.length === 0) return [];

  const values: NewCell[] = [];
  for (const row of inserted) {
    const item = row.identityKey ? byIdentity.get(row.identityKey) : undefined;
    for (const column of tableColumns) {
      if (column.kind === "input") {
        const raw = item?.values[column.name];
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

  return inserted;
}
