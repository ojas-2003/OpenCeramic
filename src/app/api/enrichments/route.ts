import { NextResponse } from "next/server";

import "@/enrichments";
import { list } from "@/enrichments/registry";
import { adapterInputKeys } from "@/lib/validateColumn";
import { handle } from "@/lib/api";

/** Registry metadata for the "Add column" picker. */
export async function GET(): Promise<NextResponse> {
  return handle(async () =>
    NextResponse.json({
      enrichments: list().map((a) => ({
        id: a.id,
        version: a.version,
        label: a.label,
        description: a.description,
        entity: a.entity,
        mode: a.mode,
        inputs: adapterInputKeys(a),
        outputFields: a.outputFields,
        // Per-row cost so the picker can show it before anything is spent.
        estimatedCreditsPerRow: safeEstimate(a),
      })),
    }),
  );
}

function safeEstimate(a: ReturnType<typeof list>[number]): number | null {
  try {
    // estimateCredits is a constant for every adapter we ship, but it takes an
    // input, so guard against one that actually reads it.
    return a.estimateCredits({} as never);
  } catch {
    return null;
  }
}
