import { NextResponse } from "next/server";
import { z } from "zod";

import { createColumn, getTable, listColumns, nextColumnPosition } from "@/db/queries";
import "@/enrichments";
import { get as getEnrichment } from "@/enrichments/registry";
import { apiError, handle, notFound, parseBody } from "@/lib/api";
import { validateColumn } from "@/lib/validateColumn";

const configSchema = z.object({
  inputs: z.record(z.string(), z.string()).default({}),
  options: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Two kinds of column. An input column is just a named text field — CSV import
 * and the seed script create them, and enrichment columns map their inputs to
 * them. An enrichment column names an adapter and its input mapping.
 */
const bodySchema = z.union([
  z.object({
    kind: z.literal("input"),
    name: z.string().min(1).max(200),
  }),
  z.object({
    kind: z.literal("enrichment").optional(),
    name: z.string().min(1).max(200).optional(),
    enrichment_id: z.string().min(1),
    config: configSchema.default({ inputs: {} }),
  }),
]);

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { id: tableId } = await params;
    const { data, error } = await parseBody(request, bodySchema);
    if (error) return error;

    const table = await getTable(tableId);
    if (!table) return notFound("Table");

    if ("kind" in data && data.kind === "input") {
      const column = await createColumn({
        tableId,
        name: data.name,
        kind: "input",
        config: { inputs: {} },
        position: await nextColumnPosition(tableId),
      });
      return NextResponse.json({ column }, { status: 201 });
    }

    const adapter = getEnrichment(data.enrichment_id);
    const existing = await listColumns(tableId);

    const invalid = validateColumn({
      tableEntity: table.entityType,
      existing,
      adapter,
      config: data.config,
    });
    if (invalid) return apiError(invalid.status, invalid.code, invalid.message, invalid.details);

    const column = await createColumn({
      tableId,
      name: data.name ?? adapter!.label,
      kind: "enrichment",
      enrichmentId: adapter!.id,
      enrichmentVersion: adapter!.version,
      config: data.config,
      position: await nextColumnPosition(tableId),
    });

    return NextResponse.json({ column }, { status: 201 });
  });
}
