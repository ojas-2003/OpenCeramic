import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ */
/* JSON column shapes                                                  */
/* ------------------------------------------------------------------ */

/**
 * A column's definition. `inputs` maps each adapter input key to the source
 * column that feeds it — this is the edge list of the table's DAG.
 */
export type ColumnConfig = {
  inputs: Record<string, string /* source column id */>;
  options?: Record<string, unknown>;
};

/** Where a cell's value came from. Written on every terminal cell write. */
export type CellProvenance = {
  cache_hit?: boolean;
  credits?: number;
  latency_ms?: number;
  api_call_id?: string;
  skipped_because?: { column_id: string; reason: string };
};

/** What a run was asked to cover. */
export type RunTarget = {
  column_ids: string[];
  row_ids?: string[];
};

/** Column ids grouped by DAG depth, in execution order. */
export type RunPlan = {
  levels: string[][];
};

export type RunCounts = {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  cache_hits: number;
};

/**
 * A source's own settings — a saved search id, a tracker list id, the rules to
 * watch. The shape is the source's business; the registry validates it with the
 * source's Zod schema before it is ever written here.
 */
export type SourceConfig = Record<string, unknown>;

/**
 * How far a source got last time it polled. It advances only on a successful
 * poll: a failed or half-finished poll writes the cursor back unchanged, so no
 * discovered entity is ever skipped over. `seen_ids` is a bounded tail of
 * recent signal ids, guarding against several signals sharing a timestamp.
 */
export type SourceCursor = {
  last_run_id?: string;
  last_signal_at?: string;
  seen_ids?: string[];
};

/** Why a row arrived, when a tracker signal put it here rather than a CSV. */
export type RowSignal = {
  kind: string;
  reason: string;
  occurred_at: string;
  raw_id?: string;
};

/* ------------------------------------------------------------------ */
/* Enums                                                               */
/* ------------------------------------------------------------------ */

export const entityType = pgEnum("entity_type", ["person", "company"]);
export const columnKind = pgEnum("column_kind", ["input", "enrichment"]);
export const cellStatus = pgEnum("cell_status", [
  "idle",
  "pending",
  "running",
  "done",
  "failed",
  "skipped",
]);
export const sourceKind = pgEnum("source_kind", ["saved_search", "tracker"]);
export const sourceStatus = pgEnum("source_status", ["active", "paused", "error"]);
export const runScope = pgEnum("run_scope", ["cell", "column", "table"]);
export const runStatus = pgEnum("run_status", [
  "planned",
  "running",
  "done",
  "failed",
  "cancelled",
]);

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

export const tables = pgTable("tables", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  entityType: entityType("entity_type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const columns = pgTable(
  "columns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tableId: uuid("table_id")
      .notNull()
      .references(() => tables.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: columnKind("kind").notNull(),
    enrichmentId: text("enrichment_id"),
    enrichmentVersion: integer("enrichment_version"),
    config: jsonb("config").$type<ColumnConfig>().notNull().default({ inputs: {} }),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("columns_table_position_idx").on(t.tableId, t.position)],
);

/**
 * A source attached to a table polls Fiber on a schedule and inserts the rows
 * it discovers. It is the push half of the app: the table fills itself rather
 * than waiting for a CSV. Sources create rows and never touch cells; that is
 * the executor's job.
 */
export const rowSources = pgTable(
  "row_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tableId: uuid("table_id")
      .notNull()
      .references(() => tables.id, { onDelete: "cascade" }),
    kind: sourceKind("kind").notNull(),
    name: text("name").notNull(),
    config: jsonb("config").$type<SourceConfig>().notNull(),
    cursor: jsonb("cursor").$type<SourceCursor>().notNull().default({}),
    status: sourceStatus("status").notNull().default("active"),
    autoEnrich: boolean("auto_enrich").notNull().default(true),
    errorMessage: text("error_message"),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("row_sources_table_idx").on(t.tableId),
    // The poller's work list: active sources, least recently polled first.
    index("row_sources_status_polled_idx").on(t.status, t.lastPolledAt),
  ],
);

export const rows = pgTable(
  "rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tableId: uuid("table_id")
      .notNull()
      .references(() => tables.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    /** Null for a row that a human uploaded. Kept when its source is deleted. */
    sourceId: uuid("source_id").references(() => rowSources.id, { onDelete: "set null" }),
    /** Normalised domain or LinkedIn URL. Null for CSV rows, which have no identity. */
    identityKey: text("identity_key"),
    signal: jsonb("signal").$type<RowSignal>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("rows_table_position_idx").on(t.tableId, t.position),
    /**
     * The whole dedupe story: polling the same source twice cannot insert the
     * same entity twice. Partial, because CSV rows have no identity_key and
     * every one of them would otherwise collide on null.
     */
    uniqueIndex("rows_table_identity_idx")
      .on(t.tableId, t.identityKey)
      .where(sql`${t.identityKey} is not null`),
  ],
);

/**
 * The cell is the job record — there is no separate jobs table. Every write is
 * an upsert on (row_id, column_id), which makes re-delivery harmless.
 */
export const cells = pgTable(
  "cells",
  {
    rowId: uuid("row_id")
      .notNull()
      .references(() => rows.id, { onDelete: "cascade" }),
    columnId: uuid("column_id")
      .notNull()
      .references(() => columns.id, { onDelete: "cascade" }),
    value: jsonb("value"),
    status: cellStatus("status").notNull().default("idle"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    runId: uuid("run_id"),
    provenance: jsonb("provenance").$type<CellProvenance>(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.rowId, t.columnId] }),
    index("cells_column_status_idx").on(t.columnId, t.status),
    index("cells_run_idx").on(t.runId),
  ],
);

export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tableId: uuid("table_id")
    .notNull()
    .references(() => tables.id, { onDelete: "cascade" }),
  scope: runScope("scope").notNull(),
  target: jsonb("target").$type<RunTarget>().notNull(),
  status: runStatus("status").notNull().default("planned"),
  plan: jsonb("plan").$type<RunPlan>().notNull(),
  counts: jsonb("counts")
    .$type<RunCounts>()
    .notNull()
    .default({ total: 0, done: 0, failed: 0, skipped: 0, cache_hits: 0 }),
  estimatedCredits: integer("estimated_credits").notNull().default(0),
  actualCredits: integer("actual_credits").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const enrichmentCache = pgTable("enrichment_cache", {
  cacheKey: text("cache_key").primaryKey(),
  value: jsonb("value"),
  credits: integer("credits").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const apiCalls = pgTable(
  "api_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    endpoint: text("endpoint").notNull(),
    requestHash: text("request_hash").notNull(),
    httpStatus: integer("http_status"),
    latencyMs: integer("latency_ms").notNull(),
    credits: integer("credits").notNull().default(0),
    responseMeta: jsonb("response_meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("api_calls_created_at_idx").on(t.createdAt)],
);

/* ------------------------------------------------------------------ */
/* Inferred row types                                                  */
/* ------------------------------------------------------------------ */

export type Table = typeof tables.$inferSelect;
export type NewTable = typeof tables.$inferInsert;

export type Column = typeof columns.$inferSelect;
export type NewColumn = typeof columns.$inferInsert;

export type Row = typeof rows.$inferSelect;
export type NewRow = typeof rows.$inferInsert;

/**
 * The persisted source. Named `…Record` because `RowSource` is the source
 * adapter interface in src/sources/types.ts, and the poller handles both.
 */
export type RowSourceRecord = typeof rowSources.$inferSelect;
export type NewRowSourceRecord = typeof rowSources.$inferInsert;

export type Cell = typeof cells.$inferSelect;
export type NewCell = typeof cells.$inferInsert;

export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;

export type EnrichmentCacheEntry = typeof enrichmentCache.$inferSelect;
export type NewEnrichmentCacheEntry = typeof enrichmentCache.$inferInsert;

export type ApiCall = typeof apiCalls.$inferSelect;
export type NewApiCall = typeof apiCalls.$inferInsert;

export type EntityType = (typeof entityType.enumValues)[number];
export type ColumnKind = (typeof columnKind.enumValues)[number];
export type CellStatus = (typeof cellStatus.enumValues)[number];
export type SourceKind = (typeof sourceKind.enumValues)[number];
export type SourceStatus = (typeof sourceStatus.enumValues)[number];
export type RunScope = (typeof runScope.enumValues)[number];
export type RunStatus = (typeof runStatus.enumValues)[number];
