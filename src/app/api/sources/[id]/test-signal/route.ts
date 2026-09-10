import { NextResponse } from "next/server";

import { getSource } from "@/db/queries";
import { getFiberClient } from "@/fiber";
import { inngest } from "@/inngest/client";
import { apiError, handle, notFound } from "@/lib/api";

type Params = { params: Promise<{ id: string }> };

/**
 * Fires a synthetic signal at a tracker list, then asks the poller to pick it
 * up. That is the whole loop on demand: signal, row, enrichment, with nobody
 * waiting for a real funding round.
 *
 * Only the dummy rules setup() attaches can be fired this way, and firing is
 * free — Fiber never evaluates a dummy rule during a scheduled run.
 */
export async function POST(_request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { id } = await params;
    const source = await getSource(id);
    if (!source) return notFound("Source");

    if (source.kind !== "tracker") {
      return apiError(
        400,
        "not_a_tracker",
        "Only tracker sources can fire a test signal. A saved search produces rows when Fiber next re-runs it — use Poll now instead.",
      );
    }

    const listId = (source.config as { listId?: unknown }).listId;
    if (typeof listId !== "string" || listId.length === 0) {
      return apiError(
        409,
        "not_set_up",
        "This tracker has no Fiber list yet, so there is nothing to fire a signal at.",
      );
    }

    const result = await getFiberClient().call(
      "/v1/tracker/fire-dummy/{listId}",
      "post",
      undefined,
      { listId },
    );

    const signals = result.data.output.signals;

    // Firing only persists the signal on Fiber's side; polling is what turns it
    // into a row. Requesting one now is what makes this feel immediate.
    await inngest.send({ name: "sources/poll.requested", data: { sourceId: id } });

    return NextResponse.json({
      fired: signals.length,
      signals: signals.map((s) => ({ id: s.id, ruleType: s.ruleType, summary: s.summary })),
    });
  });
}
