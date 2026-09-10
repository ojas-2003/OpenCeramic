import { NextResponse } from "next/server";

import { getSource } from "@/db/queries";
import { inngest } from "@/inngest/client";
import { handle, notFound } from "@/lib/api";

type Params = { params: Promise<{ id: string }> };

/**
 * Asks the poller to run this one source now. Returns immediately: a poll can
 * take as long as Fiber does, and the UI watches last_polled_at for the result.
 */
export async function POST(_request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { id } = await params;
    const source = await getSource(id);
    if (!source) return notFound("Source");

    await inngest.send({ name: "sources/poll.requested", data: { sourceId: id } });
    return NextResponse.json({ requested: true, sourceId: id }, { status: 202 });
  });
}
