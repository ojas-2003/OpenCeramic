import { NextResponse } from "next/server";
import { z } from "zod";

import { createRun, getTableWithData, upsertCells } from "@/db/queries";
import { cacheLookup } from "@/engine/cache";
import { PlanError, planRun } from "@/engine/planner";
import { triggerRun } from "@/engine/trigger";
import "@/enrichments";
import { get as getEnrichment } from "@/enrichments/registry";
import { apiError, handle, parseBody } from "@/lib/api";

const bodySchema = z.object({
  scope: z.enum(["cell", "column", "table"]),
  target: z.object({
    column_ids: z.array(z.string()).default([]),
    row_ids: z.array(z.string()).optional(),
  }),
  force: z.boolean().optional(),
  /** Plan and price without persisting cells, creating a run, or triggering. */
  dry_run: z.boolean().optional(),
});

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { id: tableId } = await params;
    const { data, error } = await parseBody(request, bodySchema);
    if (error) return error;

    // A dry run must not touch anything, so it gets no-op writers.
    const persist = !data.dry_run;
    const deps = {
      db: {
        getTableWithData,
        upsertCells: persist ? upsertCells : async () => {},
        createRun: persist
          ? createRun
          : async (run: Parameters<typeof createRun>[0]) => run as Awaited<ReturnType<typeof createRun>>,
      },
      registry: { get: getEnrichment },
      cacheLookup,
    };

    try {
      const plan = await planRun(
        { tableId, scope: data.scope, target: data.target, force: data.force },
        deps,
      );

      if (persist) await triggerRun(plan.runId);
      return NextResponse.json({ ...plan, dryRun: !persist });
    } catch (e) {
      if (e instanceof PlanError) {
        // Over budget is a conflict the user can act on; the rest are bad requests.
        const status = e.code === "over_budget" ? 409 : e.code === "table_not_found" ? 404 : 400;
        return apiError(status, e.code, planErrorMessage(e), e.details);
      }
      throw e;
    }
  });
}

function planErrorMessage(e: PlanError): string {
  if (e.code === "over_budget") {
    return `This run would cost ${e.details.estimatedCredits} credits, over the ${e.details.max} limit for a single run`;
  }
  if (e.code === "cycle") return "The columns form a cycle, so they cannot be ordered";
  if (e.code === "unknown_enrichment") return "A column references an enrichment that is not registered";
  if (e.code === "unknown_column") return "A targeted column is not in this table";
  return e.message;
}
