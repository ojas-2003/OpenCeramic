import { NextResponse } from "next/server";
import { z } from "zod";

import { deleteColumn, getColumn, listColumns, updateColumn } from "@/db/queries";
import "@/enrichments";
import { get as getEnrichment } from "@/enrichments/registry";
import { apiError, handle, notFound, parseBody } from "@/lib/api";
import { validateColumn } from "@/lib/validateColumn";

const bodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  config: z
    .object({
      inputs: z.record(z.string(), z.string()).default({}),
      options: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { id } = await params;
    const { data, error } = await parseBody(request, bodySchema);
    if (error) return error;

    const column = await getColumn(id);
    if (!column) return notFound("Column");

    if (data.config) {
      if (column.kind !== "enrichment") {
        return apiError(400, "not_an_enrichment", "Input columns have no input mapping");
      }
      const existing = await listColumns(column.tableId);
      const table = existing.length > 0 ? await import("@/db/queries").then((m) => m.getTable(column.tableId)) : null;
      if (!table) return notFound("Table");

      const invalid = validateColumn({
        tableEntity: table.entityType,
        existing,
        adapter: getEnrichment(column.enrichmentId ?? ""),
        config: data.config,
        columnId: column.id,
      });
      if (invalid) return apiError(invalid.status, invalid.code, invalid.message, invalid.details);
    }

    const updated = await updateColumn(id, {
      ...(data.name ? { name: data.name } : {}),
      ...(data.config ? { config: data.config } : {}),
    });
    return NextResponse.json({ column: updated });
  });
}

export async function DELETE(_request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { id } = await params;
    const removed = await deleteColumn(id);
    if (!removed) return notFound("Column");
    return NextResponse.json({ deleted: true });
  });
}
