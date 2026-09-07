import { NextResponse } from "next/server";

import { getCellsForRunSince, getRun } from "@/db/queries";
import { apiError, handle, notFound } from "@/lib/api";

type Params = { params: Promise<{ id: string }> };

/** The grid polls this while a run is active: the run plus cells changed since. */
export async function GET(request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { id } = await params;

    const run = await getRun(id);
    if (!run) return notFound("Run");

    const sinceParam = new URL(request.url).searchParams.get("since");
    let since: Date | null = null;
    if (sinceParam) {
      since = new Date(sinceParam);
      if (Number.isNaN(since.getTime())) {
        return apiError(400, "invalid_since", "`since` must be an ISO 8601 timestamp");
      }
    }

    const cells = await getCellsForRunSince(id, since);
    return NextResponse.json({ run, cells });
  });
}
