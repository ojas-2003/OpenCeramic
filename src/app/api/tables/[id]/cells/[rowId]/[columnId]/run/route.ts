import { NextResponse } from "next/server";

import { handle } from "@/lib/api";

type Params = { params: Promise<{ id: string; rowId: string; columnId: string }> };

/** Shorthand for a cell-scoped run; delegates to the runs route. */
export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { id, rowId, columnId } = await params;
    const { POST: createRunRoute } = await import("@/app/api/tables/[id]/runs/route");

    const forwarded = new Request(request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "cell",
        target: { column_ids: [columnId], row_ids: [rowId] },
        force: true,
      }),
    });

    return createRunRoute(forwarded, { params: Promise.resolve({ id }) });
  });
}
