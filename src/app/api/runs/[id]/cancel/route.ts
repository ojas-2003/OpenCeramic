import { NextResponse } from "next/server";

import { getRun, updateRun } from "@/db/queries";
import { cancelRun } from "@/engine/trigger";
import { apiError, handle, notFound } from "@/lib/api";

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { id } = await params;

    const run = await getRun(id);
    if (!run) return notFound("Run");
    if (run.status === "done" || run.status === "failed") {
      return apiError(409, "run_finished", `Run is already ${run.status}`);
    }

    // Cells left pending stay pending, so a re-run resumes them.
    await cancelRun(id);
    const updated = await updateRun(id, { status: "cancelled", finishedAt: new Date() });
    return NextResponse.json({ run: updated });
  });
}
