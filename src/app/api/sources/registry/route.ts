import { NextResponse } from "next/server";

import { handle } from "@/lib/api";
import "@/sources";
import { list } from "@/sources/registry";

/** Registry metadata for the "Add source" picker. */
export async function GET(): Promise<NextResponse> {
  return handle(async () =>
    NextResponse.json({
      sources: list().map((s) => ({
        id: s.id,
        kind: s.kind,
        label: s.label,
        description: s.description,
        entity: s.entity,
        configFields: s.configFields,
        // Both sources can watch either entity; config.entity is what decides.
        // The picker offers that choice rather than filtering the list by it.
        supportsSetup: typeof s.setup === "function",
      })),
    }),
  );
}
