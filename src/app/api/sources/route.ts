import { NextResponse } from "next/server";

import { listSourcesForTable } from "@/db/queries";
import { apiError, handle } from "@/lib/api";

/** Every source on one table, with its status, last poll and row count. */
export async function GET(request: Request): Promise<NextResponse> {
  return handle(async () => {
    const tableId = new URL(request.url).searchParams.get("table_id");
    if (!tableId) {
      return apiError(400, "missing_table_id", "table_id is required");
    }
    return NextResponse.json({ sources: await listSourcesForTable(tableId) });
  });
}
