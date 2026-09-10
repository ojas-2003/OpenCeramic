import {
  createRun,
  getSource,
  getTableWithData,
  insertRowsIfNew,
  listActiveSources,
  listColumns,
  updateSourceCursor,
  upsertCells,
} from "@/db/queries";
import type { SourceCursor, SourceStatus } from "@/db/schema";
import { cacheLookup } from "@/engine/cache";
import { PlanError, planRun } from "@/engine/planner";
import { pollSource } from "@/engine/poller";
import { triggerRun } from "@/engine/trigger";
import "@/enrichments"; // importing registers every adapter
import { get as getEnrichment } from "@/enrichments/registry";
import type { Ctx } from "@/enrichments/types";
import { getFiberClient } from "@/fiber";
import { inngest } from "@/inngest/client";
import "@/sources"; // importing registers every source
import { list as listRegisteredSources } from "@/sources/registry";
import type { DiscoveredRow } from "@/sources/types";

/**
 * The durable half of polling. All the cursor logic lives in
 * src/engine/poller.ts as a pure function; this file loads sources, writes the
 * rows they found, and decides whether to spend credits enriching them.
 *
 * It resolves adapters through the registry and never imports a source, the
 * same rule the executor follows for enrichments.
 */

/** The slice of Inngest's step API this file uses. */
interface StepLike {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Unattended spend is capped separately from MAX_CREDITS_PER_RUN, and far
 * lower: a human clicking Run has seen the estimate, a cron has not.
 */
const DEFAULT_MAX_AUTO_CREDITS = 200;

function maxAutoCreditsPerPoll(): number {
  const parsed = Number(process.env.MAX_AUTO_CREDITS_PER_POLL);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_AUTO_CREDITS;
}

/** What one source's poll decided about its own status. */
type Verdict = { status: SourceStatus; message: string | null };

const OK: Verdict = { status: "active", message: null };

export const pollSources = inngest.createFunction(
  {
    id: "poll-sources",
    triggers: [
      // Every 15 minutes for every active source...
      { cron: "*/15 * * * *" },
      // ...plus on demand, for one source, from the UI.
      { event: "sources/poll.requested" },
    ],
    // Step-level infrastructure failures only; a source's own error is caught
    // by pollSource and recorded against the source rather than thrown.
    retries: 2,
    // A slow poll must not overlap itself. Keyed on the requested source, so
    // two on-demand polls of one source serialise; cron sweeps, which carry no
    // sourceId, share a single bucket and so never overlap each other either.
    concurrency: { limit: 1, key: "event.data.sourceId" },
  },
  async ({ event, step, logger }) => {
    const s = step as unknown as StepLike;
    const requestedId = readSourceId(event.data);

    const records = await s.run("load-sources", async () => {
      const found = requestedId ? [await getSource(requestedId)] : await listActiveSources();
      // Narrowed deliberately: step results round-trip through JSON, and the
      // timestamps on the full record would come back as strings on a replay.
      return found
        .filter((r) => r !== null)
        .map((r) => ({
          id: r.id,
          tableId: r.tableId,
          kind: r.kind,
          name: r.name,
          config: r.config,
          cursor: r.cursor,
          autoEnrich: r.autoEnrich,
        }));
    });

    const byKind = new Map(listRegisteredSources().map((src) => [src.kind, src]));
    const ctx: Ctx = {
      fiber: getFiberClient(),
      logger: (msg, meta) => logger.info(msg, meta ?? {}),
    };

    const summary: Array<{ id: string; rows: number; status: SourceStatus }> = [];

    for (const record of records) {
      const adapter = byKind.get(record.kind);

      if (!adapter) {
        await s.run(`finalize-${record.id}`, () =>
          finalize(record.id, record.cursor, {
            status: "error",
            message: `No source is registered for kind "${record.kind}"`,
          }),
        );
        summary.push({ id: record.id, rows: 0, status: "error" });
        continue;
      }

      const outcome = await s.run(`poll-${record.id}`, () =>
        pollSource(
          { source: adapter, config: record.config, cursor: record.cursor },
          ctx,
        ),
      );

      if (outcome.error) {
        // The cursor written back is the one the poll started with. pollSource
        // guarantees that; writing record.cursor here would too, and the
        // duplication is deliberate belt-and-braces.
        await s.run(`finalize-${record.id}`, () =>
          finalize(record.id, record.cursor, {
            status: "error",
            message: `${outcome.error!.code}: ${outcome.error!.message}`,
          }),
        );
        summary.push({ id: record.id, rows: 0, status: "error" });
        continue;
      }

      const insertedIds = await s.run(`insert-${record.id}`, async () => {
        const inserted = await insertRowsIfNew(
          record.tableId,
          record.id,
          outcome.rows as DiscoveredRow[],
        );
        return inserted.map((r) => r.id);
      });

      const verdict =
        record.autoEnrich && insertedIds.length > 0
          ? await s.run(`enrich-${record.id}`, () =>
              enrichNewRows(record.tableId, insertedIds),
            )
          : OK;

      await s.run(`finalize-${record.id}`, () =>
        finalize(record.id, outcome.cursor as SourceCursor, verdict, outcome.note),
      );

      logger.info("polled source", {
        sourceId: record.id,
        name: record.name,
        found: outcome.rows.length,
        inserted: insertedIds.length,
        status: verdict.status,
        note: outcome.note,
      });
      summary.push({ id: record.id, rows: insertedIds.length, status: verdict.status });
    }

    return { polled: summary.length, sources: summary };
  },
);

/* ------------------------------------------------------------------ */

/**
 * Plans a run over the rows that just arrived and, if it is affordable, starts
 * it.
 *
 * The budget check happens **here, before triggerRun** — not inside the
 * executor. By the time the executor is running, the credits are already being
 * spent; the only place a cap can actually prevent spending is between pricing
 * and dispatch. planRun has already written the cells as pending, so a run this
 * refuses to start is left sitting there for a human to approve.
 *
 * Exported so the over-budget path can be tested without an Inngest run.
 */
export async function enrichNewRows(tableId: string, rowIds: string[]): Promise<Verdict> {
  const columns = await listColumns(tableId);
  const columnIds = columns.filter((c) => c.kind === "enrichment").map((c) => c.id);
  if (columnIds.length === 0) return OK;

  try {
    const plan = await planRun(
      {
        tableId,
        // Scoped to the new rows only. Every enrichment column, but never a row
        // that was already in the table.
        scope: "table",
        target: { column_ids: columnIds, row_ids: rowIds },
      },
      {
        db: { getTableWithData, upsertCells, createRun },
        registry: { get: getEnrichment },
        cacheLookup,
      },
    );

    const cap = maxAutoCreditsPerPoll();
    if (plan.estimatedCredits > cap) {
      return {
        status: "paused",
        message:
          `Paused: enriching ${rowIds.length} new row${rowIds.length === 1 ? "" : "s"} ` +
          `would cost about ${plan.estimatedCredits} credits, over the ` +
          `${cap}-credit cap for an unattended poll. The cells are waiting — run them by hand, ` +
          `or raise MAX_AUTO_CREDITS_PER_POLL.`,
      };
    }

    await triggerRun(plan.runId);
    return OK;
  } catch (e) {
    if (e instanceof PlanError) {
      // over_budget from planRun is the per-run cap, not the per-poll one. It
      // wrote nothing, so there are no pending cells — but pausing is still the
      // honest state, because polling again will hit the same wall.
      return {
        status: e.code === "over_budget" ? "paused" : "error",
        message: `Could not plan a run for the new rows (${e.code}): ${e.message}`,
      };
    }
    throw e;
  }
}

/**
 * The only write that moves a source forward. Status and message travel with
 * the cursor so a source that recovers clears its own error, and one that has
 * just been paused on budget does not have its status overwritten.
 */
function finalize(
  sourceId: string,
  cursor: SourceCursor,
  verdict: Verdict,
  note?: string,
): Promise<unknown> {
  return updateSourceCursor(sourceId, cursor, {
    status: verdict.status,
    // A note ("run in progress") is not an error, but it is worth showing, and
    // error_message is where the UI already looks.
    errorMessage: verdict.message ?? note ?? null,
    lastPolledAt: new Date(),
  });
}

function readSourceId(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const id = (data as { sourceId?: unknown }).sourceId;
  return typeof id === "string" && id.length > 0 ? id : null;
}
