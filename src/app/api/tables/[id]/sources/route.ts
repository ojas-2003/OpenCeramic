import { NextResponse } from "next/server";
import { z } from "zod";

import { createSource, getTable } from "@/db/queries";
import { apiError, handle, notFound, parseBody } from "@/lib/api";
import { getFiberClient } from "@/fiber";
import "@/sources";
import { get as getSourceAdapter } from "@/sources/registry";

const bodySchema = z.object({
  source_id: z.string().min(1),
  name: z.string().min(1).max(200),
  config: z.record(z.string(), z.unknown()).default({}),
  auto_enrich: z.boolean().default(true),
});

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { id: tableId } = await params;
    const { data, error } = await parseBody(request, bodySchema);
    if (error) return error;

    const table = await getTable(tableId);
    if (!table) return notFound("Table");

    const adapter = getSourceAdapter(data.source_id);
    if (!adapter) {
      return apiError(400, "unknown_source", `No source is registered as "${data.source_id}"`);
    }

    // The source's own schema is the authority on its config, and it runs
    // before setup() so a malformed config never reaches Fiber.
    const parsed = adapter.config.safeParse(data.config);
    if (!parsed.success) {
      return apiError(
        400,
        "invalid_config",
        parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; "),
      );
    }

    // setup() creates the Fiber-side object and hands back the ids that address
    // it. Merged in before the insert, so a stored source is always addressable.
    let config = parsed.data as Record<string, unknown>;
    if (adapter.setup) {
      try {
        const patch = await adapter.setup(config, {
          fiber: getFiberClient(),
          logger: () => {},
        });
        config = { ...config, ...patch };
      } catch (e) {
        return apiError(
          502,
          "setup_failed",
          `Could not create this source on Fiber: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    const source = await createSource({
      tableId,
      kind: adapter.kind,
      name: data.name,
      config,
      autoEnrich: data.auto_enrich,
      cursor: {},
    });

    return NextResponse.json({ source }, { status: 201 });
  });
}
