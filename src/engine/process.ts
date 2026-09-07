import type { Cell, CellProvenance, ColumnConfig, RunCounts } from "@/db/schema";
import type { CacheStore } from "@/engine/cache";
import { cacheTtlSeconds } from "@/engine/cache";
import { toAdapterError } from "@/engine/errors";
import { parseSourceRef, readSourceValue } from "@/engine/sourceRef";
import type { AdapterError, AnyEnrichment, Ctx } from "@/enrichments/types";
import type { FiberClient } from "@/fiber/client";

/**
 * The pure core of the executor. Nothing here knows about Inngest or the
 * database: it takes work items and dependencies and returns outcomes. The
 * Inngest function in executor.ts is a thin wrapper that loads cells, calls
 * these, and writes the results.
 */

export type CellWork = {
  rowId: string;
  columnId: string;
  input: unknown;
};

export type CellOutcome = {
  rowId: string;
  columnId: string;
  status: "done" | "failed" | "skipped";
  value: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  provenance: CellProvenance;
};

export type Logger = (msg: string, meta?: object) => void;

export interface ProcessDeps {
  fiber: FiberClient;
  cache: CacheStore;
  logger: Logger;
  /** Retry backoff. A no-op in tests keeps them fast. */
  sleep?: (ms: number) => Promise<void>;
}

/** Backoff between retries, per the guide: 1s, 4s, 10s. */
export const RETRY_BACKOFF_MS = [1_000, 4_000, 10_000] as const;
export const MAX_ATTEMPTS = 3;
export const DEFAULT_CONCURRENCY = 5;
export const DEFAULT_BATCH_SIZE = 25;
export const SYNC_CHUNK_SIZE = 10;

/* ------------------------------------------------------------------ */
/* Input resolution                                                    */
/* ------------------------------------------------------------------ */

export type ResolveOutput = {
  runnable: CellWork[];
  /** Cells that cannot run: skipped upstream, or invalid input. */
  blocked: CellOutcome[];
};

const cellKey = (rowId: string, columnId: string) => `${rowId}:${columnId}`;

/**
 * Decides, for each pending cell, whether it can run. A cell whose source is
 * failed, skipped or empty becomes `skipped` with a reason the user can read —
 * never a silently blank cell (DESIGN.md section 4.3).
 */
export function resolveCells(
  cells: Array<Pick<Cell, "rowId" | "columnId">>,
  config: ColumnConfig,
  adapter: AnyEnrichment,
  sourceCells: Map<string, Cell>,
): ResolveOutput {
  const runnable: CellWork[] = [];
  const blocked: CellOutcome[] = [];

  for (const cell of cells) {
    const raw: Record<string, unknown> = {};
    let blocker: { column_id: string; reason: string } | null = null;

    for (const [inputKey, mapping] of Object.entries(config?.inputs ?? {})) {
      const ref = parseSourceRef(String(mapping));
      const read = readSourceValue(sourceCells.get(cellKey(cell.rowId, ref.columnId)), ref.field);
      if (!read.ok) {
        blocker = { column_id: ref.columnId, reason: read.reason };
        break;
      }
      raw[inputKey] = read.value;
    }

    if (blocker) {
      blocked.push({
        rowId: cell.rowId,
        columnId: cell.columnId,
        status: "skipped",
        value: null,
        errorCode: null,
        errorMessage: null,
        provenance: { skipped_because: blocker },
      });
      continue;
    }

    const parsed = adapter.inputs.safeParse(raw);
    if (!parsed.success) {
      blocked.push({
        rowId: cell.rowId,
        columnId: cell.columnId,
        status: "failed",
        value: null,
        errorCode: "invalid_input",
        errorMessage: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        provenance: {},
      });
      continue;
    }

    runnable.push({ rowId: cell.rowId, columnId: cell.columnId, input: parsed.data });
  }

  return { runnable, blocked };
}

/* ------------------------------------------------------------------ */
/* Provenance capture                                                  */
/* ------------------------------------------------------------------ */

/**
 * Wraps the client so a cell's provenance can record what the adapter actually
 * spent. The adapter returns only its output, so credits and the api_calls id
 * would otherwise be lost.
 */
function recordingFiber(fiber: FiberClient): {
  client: FiberClient;
  credits: number;
  apiCallId: string | undefined;
} {
  const record = { credits: 0, apiCallId: undefined as string | undefined };
  const client: FiberClient = {
    call: async (path, method, body) => {
      const result = await fiber.call(path, method, body);
      record.credits += result.credits;
      record.apiCallId = result.apiCallId;
      return result;
    },
  };
  return {
    client,
    get credits() {
      return record.credits;
    },
    get apiCallId() {
      return record.apiCallId;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Bounded concurrency                                                 */
/* ------------------------------------------------------------------ */

/** Small semaphore; avoids adding p-limit for twelve lines of logic. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/* ------------------------------------------------------------------ */
/* sync mode                                                           */
/* ------------------------------------------------------------------ */

function doneOutcome(
  work: CellWork,
  value: unknown,
  provenance: CellProvenance,
): CellOutcome {
  return {
    rowId: work.rowId,
    columnId: work.columnId,
    status: "done",
    value: value ?? null,
    errorCode: null,
    errorMessage: null,
    provenance,
  };
}

function failedOutcome(work: CellWork, error: AdapterError): CellOutcome {
  return {
    rowId: work.rowId,
    columnId: work.columnId,
    status: "failed",
    value: null,
    errorCode: error.code,
    errorMessage: error.message,
    provenance: {},
  };
}

/**
 * Runs one chunk of sync cells.
 *
 * Contract: a single cell's failure never escapes. Everything an adapter throws
 * is recorded on that cell and the rest of the chunk continues. Only an
 * infrastructure failure — the cache or the database being unreachable — is
 * allowed to propagate, because that is the only case where retrying the whole
 * step is the right answer.
 */
export async function processChunk(
  work: readonly CellWork[],
  adapter: AnyEnrichment,
  deps: ProcessDeps,
): Promise<CellOutcome[]> {
  if (work.length === 0) return [];

  const ttl = adapter.ttlSeconds ?? cacheTtlSeconds();
  const keys = work.map((w) => adapter.cacheKey(w.input));
  const cached = await deps.cache.getMany([...new Set(keys)]);

  return mapWithConcurrency(work, adapter.concurrency ?? DEFAULT_CONCURRENCY, async (item, i) => {
    const key = keys[i];

    const hit = cached.get(key);
    if (hit) {
      return doneOutcome(item, hit.value, { cache_hit: true, credits: 0, latency_ms: 0 });
    }

    const recorder = recordingFiber(deps.fiber);
    const ctx: Ctx = { fiber: recorder.client, logger: deps.logger };
    const startedAt = Date.now();

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const value = await adapter.run!(item.input, ctx);
        const provenance: CellProvenance = {
          cache_hit: false,
          credits: recorder.credits,
          latency_ms: Date.now() - startedAt,
          ...(recorder.apiCallId ? { api_call_id: recorder.apiCallId } : {}),
        };
        // "No data found" is a successful null — cache it so we do not pay to
        // rediscover the same absence.
        await deps.cache.set(key, value ?? null, recorder.credits, ttl);
        return doneOutcome(item, value, provenance);
      } catch (e) {
        const error = toAdapterError(e);
        if (!error.retryable || attempt === MAX_ATTEMPTS) {
          deps.logger("cell failed", { columnId: item.columnId, rowId: item.rowId, code: error.code });
          return failedOutcome(item, error);
        }
        await (deps.sleep ?? defaultSleep)(RETRY_BACKOFF_MS[attempt - 1]);
      }
    }

    // Unreachable: the loop always returns.
    return failedOutcome(item, { code: "adapter_error", message: "retry loop exhausted", retryable: false });
  });
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* batch mode                                                          */
/* ------------------------------------------------------------------ */

/**
 * One runBatch call for the whole chunk. Results map positionally onto the
 * inputs, and an AdapterError anywhere in the array fails only its own cell.
 * Cache hits are served first and excluded from the call.
 */
export async function processBatchChunk(
  work: readonly CellWork[],
  adapter: AnyEnrichment,
  deps: ProcessDeps,
): Promise<CellOutcome[]> {
  if (work.length === 0) return [];

  const ttl = adapter.ttlSeconds ?? cacheTtlSeconds();
  const keys = work.map((w) => adapter.cacheKey(w.input));
  const cached = await deps.cache.getMany([...new Set(keys)]);

  const outcomes = new Array<CellOutcome | undefined>(work.length);
  const pending: Array<{ item: CellWork; index: number; key: string }> = [];

  work.forEach((item, i) => {
    const hit = cached.get(keys[i]);
    if (hit) {
      outcomes[i] = doneOutcome(item, hit.value, { cache_hit: true, credits: 0, latency_ms: 0 });
    } else {
      pending.push({ item, index: i, key: keys[i] });
    }
  });

  if (pending.length > 0) {
    const recorder = recordingFiber(deps.fiber);
    const ctx: Ctx = { fiber: recorder.client, logger: deps.logger };
    const startedAt = Date.now();

    let results: Array<unknown>;
    try {
      results = await adapter.runBatch!(pending.map((p) => p.item.input), ctx);
    } catch (e) {
      // The whole batch call failed: every cell in it fails with that error.
      const error = toAdapterError(e);
      for (const p of pending) outcomes[p.index] = failedOutcome(p.item, error);
      return outcomes as CellOutcome[];
    }

    const latency = Date.now() - startedAt;
    // Credits are charged for the batch, not per cell; spread them evenly for
    // per-cell provenance. The run's actual_credits is summed from api_calls,
    // not from these, so the division does not have to be lossless.
    const perCell = pending.length > 0 ? recorder.credits / pending.length : 0;
    // enrichment_cache.credits is an integer column, so the share has to be
    // whole before it is written there.
    const perCellWhole = Math.round(perCell);

    for (const [n, p] of pending.entries()) {
      const result = results[n];

      // runBatch declares Array<O | null | AdapterError>; a short array or an
      // undefined slot means the adapter gave this cell no answer. That is not
      // the same as a null answer, which is a successful "nothing found".
      if (n >= results.length || result === undefined) {
        outcomes[p.index] = failedOutcome(p.item, {
          code: "batch_result_missing",
          message: "runBatch returned no result for this input",
          retryable: false,
        });
        continue;
      }

      if (isAdapterErrorResult(result)) {
        outcomes[p.index] = failedOutcome(p.item, result);
        continue;
      }

      const provenance: CellProvenance = {
        cache_hit: false,
        credits: perCell,
        latency_ms: latency,
        ...(recorder.apiCallId ? { api_call_id: recorder.apiCallId } : {}),
      };
      await deps.cache.set(p.key, result ?? null, perCellWhole, ttl);
      outcomes[p.index] = doneOutcome(p.item, result ?? null, provenance);
    }
  }

  return outcomes as CellOutcome[];
}

function isAdapterErrorResult(r: unknown): r is AdapterError {
  if (!r || typeof r !== "object") return false;
  const c = r as Record<string, unknown>;
  return typeof c.code === "string" && typeof c.message === "string" && typeof c.retryable === "boolean";
}

/* ------------------------------------------------------------------ */
/* async mode                                                          */
/* ------------------------------------------------------------------ */

/** step.run in production; a direct call in tests. */
export type StepRunner = <T>(id: string, fn: () => Promise<T>) => Promise<T>;
/** step.sleep in production; a no-op in tests. */
export type StepSleeper = (id: string, ms: number) => Promise<void>;

export interface AsyncDeps extends ProcessDeps {
  runStep?: StepRunner;
  wait?: StepSleeper;
}

export const POLL_INTERVAL_MS = 5_000;
export const MAX_POLLS = 24; // 24 x 5s = 2 minutes

const directRunner: StepRunner = (_id, fn) => fn();
const noWait: StepSleeper = async () => {};

/**
 * start() once, then poll on an interval until the adapter reports a terminal
 * state or the budget runs out. In the Inngest function each start and poll is
 * its own durable step and the wait is step.sleep, so a poll loop survives a
 * redeploy; in tests they are plain calls.
 */
export async function processAsyncCell(
  work: CellWork,
  adapter: AnyEnrichment,
  deps: AsyncDeps,
): Promise<CellOutcome> {
  const runStep = deps.runStep ?? directRunner;
  const wait = deps.wait ?? noWait;
  const ttl = adapter.ttlSeconds ?? cacheTtlSeconds();
  const key = adapter.cacheKey(work.input);

  const cached = await deps.cache.getMany([key]);
  const hit = cached.get(key);
  if (hit) {
    return doneOutcome(work, hit.value, { cache_hit: true, credits: 0, latency_ms: 0 });
  }

  const recorder = recordingFiber(deps.fiber);
  const ctx: Ctx = { fiber: recorder.client, logger: deps.logger };
  const startedAt = Date.now();

  let handle: string;
  try {
    const started = await runStep(`start-${work.columnId}-${work.rowId}`, () =>
      adapter.start!(work.input, ctx),
    );
    handle = started.handle;
  } catch (e) {
    return failedOutcome(work, toAdapterError(e));
  }

  for (let attempt = 1; attempt <= MAX_POLLS; attempt++) {
    await wait(`poll-wait-${work.columnId}-${work.rowId}-${attempt}`, POLL_INTERVAL_MS);

    let polled;
    try {
      polled = await runStep(`poll-${work.columnId}-${work.rowId}-${attempt}`, () =>
        adapter.poll!(handle, ctx),
      );
    } catch (e) {
      return failedOutcome(work, toAdapterError(e));
    }

    if (polled.state === "pending") continue;

    if (polled.state === "failed") {
      return failedOutcome(work, polled.error);
    }

    const provenance: CellProvenance = {
      cache_hit: false,
      credits: recorder.credits,
      latency_ms: Date.now() - startedAt,
      ...(recorder.apiCallId ? { api_call_id: recorder.apiCallId } : {}),
    };
    await deps.cache.set(key, polled.value ?? null, recorder.credits, ttl);
    return doneOutcome(work, polled.value, provenance);
  }

  return failedOutcome(work, {
    code: "poll_timeout",
    message: `No terminal state after ${MAX_POLLS} polls (${(MAX_POLLS * POLL_INTERVAL_MS) / 1000}s)`,
    retryable: false,
  });
}

/** Dispatch on the adapter's declared mode. */
export async function processWork(
  work: readonly CellWork[],
  adapter: AnyEnrichment,
  deps: AsyncDeps,
): Promise<CellOutcome[]> {
  if (adapter.mode === "sync") return processChunk(work, adapter, deps);
  if (adapter.mode === "batch") return processBatchChunk(work, adapter, deps);

  const limit = adapter.concurrency ?? DEFAULT_CONCURRENCY;
  return mapWithConcurrency(work, limit, (item) => processAsyncCell(item, adapter, deps));
}

/* ------------------------------------------------------------------ */
/* Run counts                                                          */
/* ------------------------------------------------------------------ */

/** Pure: kept out of executor.ts so it is testable without a database. */
export function countCells(cells: Array<Pick<Cell, "status" | "provenance">>): RunCounts {
  const counts: RunCounts = { total: cells.length, done: 0, failed: 0, skipped: 0, cache_hits: 0 };
  for (const cell of cells) {
    if (cell.status === "done") counts.done += 1;
    else if (cell.status === "failed") counts.failed += 1;
    else if (cell.status === "skipped") counts.skipped += 1;
    if ((cell.provenance as CellProvenance | null)?.cache_hit) counts.cache_hits += 1;
  }
  return counts;
}
