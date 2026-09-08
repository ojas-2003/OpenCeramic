import { NextResponse } from "next/server";
import { z } from "zod";

import { createColumn, createRows, getTable, listColumns, nextColumnPosition } from "@/db/queries";
import { getFiberClient } from "@/fiber";
import { FiberError } from "@/fiber/errors";
import { apiError, handle, notFound, parseBody } from "@/lib/api";
import { fetchHealedRows, pickImportColumns, pollMosaic, startMosaic } from "@/lib/mosaic";

type Params = { params: Promise<{ id: string }> };

const startSchema = z.object({
  source_url: z.string().url(),
  custom_instructions: z.string().max(1000).optional(),
  max_rows: z.number().int().positive().max(1000).optional(),
});

/** Kicks off a Mosaic heal for a public CSV / Sheet URL. */
export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { id: tableId } = await params;
    const { data, error } = await parseBody(request, startSchema);
    if (error) return error;
    if (!(await getTable(tableId))) return notFound("Table");

    try {
      const started = await startMosaic(getFiberClient(), data.source_url, {
        customInstructions: data.custom_instructions,
        maxRows: data.max_rows,
      });
      return NextResponse.json(started, { status: 202 });
    } catch (e) {
      if (e instanceof FiberError) return apiError(e.status || 502, e.code, e.message);
      throw e;
    }
  });
}

/**
 * Polls the run. Once Mosaic reports `done`, the healed CSV is downloaded,
 * turned into input columns and rows, and the counts are returned — so the
 * client polls one endpoint rather than orchestrating three.
 */
export async function GET(request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { id: tableId } = await params;
    const runId = new URL(request.url).searchParams.get("runId");
    if (!runId) return apiError(400, "missing_run_id", "runId query parameter is required");
    if (!(await getTable(tableId))) return notFound("Table");

    let run;
    try {
      run = await pollMosaic(getFiberClient(), runId);
    } catch (e) {
      if (e instanceof FiberError) return apiError(e.status || 502, e.code, e.message);
      throw e;
    }

    if (run.status !== "done") {
      return NextResponse.json({ status: run.status, stats: run.stats, rowsCreated: 0 });
    }
    if (!run.outputCsvUrl) {
      return apiError(502, "no_output", "Mosaic reported done but returned no CSV");
    }

    const { headers, rows } = await fetchHealedRows(run.outputCsvUrl);
    const keep = pickImportColumns(headers);

    const existing = await listColumns(tableId);
    const byName = new Set(existing.filter((c) => c.kind === "input").map((c) => c.name));
    for (const header of keep) {
      if (byName.has(header)) continue;
      await createColumn({
        tableId,
        name: header,
        kind: "input",
        config: { inputs: {} },
        position: await nextColumnPosition(tableId),
      });
    }

    const created = await createRows(
      tableId,
      rows.map((row) => Object.fromEntries(keep.map((h) => [h, row[h] ?? ""]))),
    );

    return NextResponse.json({
      status: run.status,
      stats: run.stats,
      rowsCreated: created.length,
      columns: keep,
      reportUrl: run.reportUrl,
    });
  });
}
