import { randomUUID } from "node:crypto";

import type { Cell, ColumnConfig, NewCell, NewRun, Run } from "@/db/schema";
import type { TableWithData } from "@/db/queries";
import type { AnyEnrichment } from "@/enrichments/types";

/* ------------------------------------------------------------------ */
/* Contract                                                            */
/* ------------------------------------------------------------------ */

export interface PlanInput {
  tableId: string;
  scope: "cell" | "column" | "table";
  target: { column_ids: string[]; row_ids?: string[] };
  force?: boolean;
}

export interface PlanResult {
  runId: string;
  levels: string[][]; // column ids grouped by DAG depth, in execution order
  counts: { total: number; cached: number };
  estimatedCredits: number;
}

export interface PlanDeps {
  db: {
    getTableWithData(tableId: string): Promise<TableWithData | null>;
    upsertCells(cells: NewCell[]): Promise<void>;
    createRun(run: NewRun): Promise<Run>;
  };
  registry: { get(id: string): AnyEnrichment | undefined };
  cacheLookup: (keys: string[]) => Promise<Set<string>>;
}

export type PlanErrorCode =
  | "cycle"
  | "over_budget"
  | "table_not_found"
  | "unknown_enrichment"
  | "unknown_column";

export class PlanError extends Error {
  readonly code: PlanErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: PlanErrorCode, details: Record<string, unknown> = {}) {
    super(`${code}${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ""}`);
    this.name = "PlanError";
    this.code = code;
    this.details = details;
  }
}

/* ------------------------------------------------------------------ */
/* Pure graph functions                                                */
/* ------------------------------------------------------------------ */

/** A dependency edge: the source column feeds the dependent column. */
export type Edge = readonly [from: string, to: string];

/**
 * Kahn's algorithm, grouped by depth: every column in a level has all of its
 * dependencies satisfied by earlier levels, so a level can run in parallel.
 *
 * Edges touching a node outside `nodes` are ignored. That matters because an
 * enrichment column's inputs usually come from an input column, which is never
 * part of a run — counting it would leave the dependent stuck at in-degree 1.
 */
export function topoSortLevels(edges: readonly Edge[], nodes: readonly string[]): string[][] {
  const nodeSet = new Set(nodes);
  const indegree = new Map<string, number>(nodes.map((n) => [n, 0]));
  const adjacency = new Map<string, Set<string>>();

  for (const [from, to] of edges) {
    if (!nodeSet.has(from) || !nodeSet.has(to) || from === to) {
      // A self-edge is a cycle; leave it to the completeness check below.
      if (from === to && nodeSet.has(from)) indegree.set(from, (indegree.get(from) ?? 0) + 1);
      continue;
    }
    const seen = adjacency.get(from) ?? new Set<string>();
    if (seen.has(to)) continue; // duplicate edge must not double-count in-degree
    seen.add(to);
    adjacency.set(from, seen);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }

  const levels: string[][] = [];
  const placed = new Set<string>();
  let frontier = nodes.filter((n) => indegree.get(n) === 0);

  while (frontier.length > 0) {
    levels.push(frontier);
    for (const n of frontier) placed.add(n);

    const ready = new Set<string>();
    for (const n of frontier) {
      for (const m of adjacency.get(n) ?? []) {
        const remaining = (indegree.get(m) ?? 0) - 1;
        indegree.set(m, remaining);
        if (remaining === 0) ready.add(m);
      }
    }
    // Filter through `nodes` so level ordering is deterministic.
    frontier = nodes.filter((n) => ready.has(n));
  }

  if (placed.size !== nodeSet.size) {
    const unplaced = nodes.filter((n) => !placed.has(n));
    throw new PlanError("cycle", { columns: unplaced });
  }

  return levels;
}

/**
 * Every node transitively reachable from `nodeIds`, excluding the seeds.
 * Re-running a column invalidates whatever depends on it, so those columns join
 * the run whether or not the user selected them.
 */
export function downstreamOf(edges: readonly Edge[], nodeIds: readonly string[]): string[] {
  const adjacency = new Map<string, string[]>();
  for (const [from, to] of edges) {
    adjacency.set(from, [...(adjacency.get(from) ?? []), to]);
  }

  const seeds = new Set(nodeIds);
  const found = new Set<string>();
  const queue = [...nodeIds];

  while (queue.length > 0) {
    for (const next of adjacency.get(queue.shift()!) ?? []) {
      if (found.has(next)) continue;
      found.add(next);
      queue.push(next);
    }
  }

  return [...found].filter((n) => !seeds.has(n));
}

/** config.inputs is the edge list: each value is a source column id. */
export function edgesFromColumns(
  columns: ReadonlyArray<{ id: string; config: ColumnConfig }>,
): Edge[] {
  const edges: Edge[] = [];
  for (const column of columns) {
    for (const sourceColumnId of Object.values(column.config?.inputs ?? {})) {
      edges.push([sourceColumnId, column.id]);
    }
  }
  return edges;
}

/* ------------------------------------------------------------------ */
/* planRun                                                             */
/* ------------------------------------------------------------------ */

const DEFAULT_MAX_CREDITS = 2000;

function maxCreditsPerRun(): number {
  const parsed = Number(process.env.MAX_CREDITS_PER_RUN);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CREDITS;
}

const cellKey = (rowId: string, columnId: string) => `${rowId}:${columnId}`;

/**
 * Reads the source cells feeding one cell. `complete` is false when any source
 * is missing, not done, or null — those cells cannot be priced yet because
 * their upstream has not run.
 */
function resolveInputs(
  config: ColumnConfig,
  rowId: string,
  cellByKey: Map<string, Cell>,
): { resolved: Record<string, unknown>; complete: boolean } {
  const resolved: Record<string, unknown> = {};
  let complete = true;

  for (const [inputKey, sourceColumnId] of Object.entries(config?.inputs ?? {})) {
    const source = cellByKey.get(cellKey(rowId, sourceColumnId));
    if (source && source.status === "done" && source.value !== null && source.value !== undefined) {
      resolved[inputKey] = source.value;
    } else {
      complete = false;
    }
  }

  return { resolved, complete };
}

export async function planRun(input: PlanInput, deps: PlanDeps): Promise<PlanResult> {
  const data = await deps.db.getTableWithData(input.tableId);
  if (!data) throw new PlanError("table_not_found", { tableId: input.tableId });

  const { columns, rows, cells } = data;
  const columnById = new Map(columns.map((c) => [c.id, c]));
  const edges = edgesFromColumns(columns);

  // 1-2. Which columns run. Input columns never do.
  const enrichmentIds = new Set(
    columns.filter((c) => c.kind === "enrichment").map((c) => c.id),
  );

  let inScope: Set<string>;
  if (input.scope === "table") {
    inScope = enrichmentIds;
  } else {
    for (const id of input.target.column_ids) {
      if (!columnById.has(id)) throw new PlanError("unknown_column", { columnId: id });
    }
    // Re-running a column invalidates everything downstream of it.
    inScope = new Set(
      [...input.target.column_ids, ...downstreamOf(edges, input.target.column_ids)].filter((id) =>
        enrichmentIds.has(id),
      ),
    );
  }

  // `columns` arrives ordered by position, which makes levels deterministic.
  const selected = columns.filter((c) => inScope.has(c.id)).map((c) => c.id);

  // 3. Topological order, grouped into parallel levels.
  const levels = topoSortLevels(edges, selected);

  // Fail fast on a column whose adapter is not registered, before any writes.
  const adapterFor = new Map<string, AnyEnrichment>();
  for (const columnId of selected) {
    const column = columnById.get(columnId)!;
    const adapter = column.enrichmentId ? deps.registry.get(column.enrichmentId) : undefined;
    if (!adapter) {
      throw new PlanError("unknown_enrichment", {
        columnId,
        enrichmentId: column.enrichmentId,
      });
    }
    adapterFor.set(columnId, adapter);
  }

  // 4. Which rows.
  const rowIds = input.target.row_ids
    ? rows.filter((r) => input.target.row_ids!.includes(r.id)).map((r) => r.id)
    : rows.map((r) => r.id);

  // 5. Which cells. A done cell is left untouched unless force is set.
  const cellByKey = new Map(cells.map((c) => [cellKey(c.rowId, c.columnId), c]));

  type Planned = {
    rowId: string;
    columnId: string;
    adapter: AnyEnrichment;
    input: Record<string, unknown>;
    cacheKey: string | null;
    existing: Cell | undefined;
  };

  const planned: Planned[] = [];
  for (const columnId of selected) {
    const column = columnById.get(columnId)!;
    const adapter = adapterFor.get(columnId)!;

    for (const rowId of rowIds) {
      const existing = cellByKey.get(cellKey(rowId, columnId));
      if (existing?.status === "done" && !input.force) continue;

      const { resolved, complete } = resolveInputs(column.config, rowId, cellByKey);

      // 6. Only a cell whose inputs resolve right now can be priced against the
      // cache. Anything waiting on upstream is assumed to be a miss.
      let cacheKey: string | null = null;
      let priced: Record<string, unknown> = resolved;
      if (complete) {
        const parsed = adapter.inputs.safeParse(resolved);
        if (parsed.success) {
          priced = parsed.data as Record<string, unknown>;
          cacheKey = adapter.cacheKey(priced);
        }
      }

      planned.push({ rowId, columnId, adapter, input: priced, cacheKey, existing });
    }
  }

  // One cache round trip for the whole run, not one per cell.
  const keys = planned.map((p) => p.cacheKey).filter((k): k is string => k !== null);
  const cachedKeys = keys.length > 0 ? await deps.cacheLookup(keys) : new Set<string>();

  let cached = 0;
  let estimatedCredits = 0;
  for (const p of planned) {
    if (p.cacheKey !== null && cachedKeys.has(p.cacheKey)) {
      cached += 1;
      continue;
    }
    estimatedCredits += p.adapter.estimateCredits(p.input);
  }

  // 7. Refuse before writing anything, so an over-budget plan leaves no trace.
  const max = maxCreditsPerRun();
  if (estimatedCredits > max) {
    throw new PlanError("over_budget", { estimatedCredits, max });
  }

  // 8. Persist: the run first, so no cell ever points at a run that is absent.
  const runId = randomUUID();
  await deps.db.createRun({
    id: runId,
    tableId: input.tableId,
    scope: input.scope,
    target: input.target,
    status: "planned",
    plan: { levels },
    counts: { total: planned.length, done: 0, failed: 0, skipped: 0, cache_hits: 0 },
    estimatedCredits,
    actualCredits: 0,
  });

  await deps.db.upsertCells(
    planned.map((p) => ({
      rowId: p.rowId,
      columnId: p.columnId,
      status: "pending" as const,
      runId,
      // A re-run that fails must not destroy the previous good value; the
      // provenance describes the previous run, so it goes.
      value: p.existing?.value ?? null,
      provenance: null,
      errorCode: null,
      errorMessage: null,
    })),
  );

  return {
    runId,
    levels,
    counts: { total: planned.length, cached },
    estimatedCredits,
  };
}
