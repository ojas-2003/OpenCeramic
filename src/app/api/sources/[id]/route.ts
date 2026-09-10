import { NextResponse } from "next/server";
import { z } from "zod";

import { deleteSource, getSource, updateSource } from "@/db/queries";
import { handle, notFound, parseBody } from "@/lib/api";

const bodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  status: z.enum(["active", "paused", "error"]).optional(),
  auto_enrich: z.boolean().optional(),
});

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { id } = await params;
    const { data, error } = await parseBody(request, bodySchema);
    if (error) return error;

    const existing = await getSource(id);
    if (!existing) return notFound("Source");

    const source = await updateSource(id, {
      ...(data.name ? { name: data.name } : {}),
      ...(data.auto_enrich === undefined ? {} : { autoEnrich: data.auto_enrich }),
      // Resuming a paused or errored source clears the message that explained
      // it, so the banner does not outlive the condition.
      ...(data.status ? { status: data.status, errorMessage: null } : {}),
    });

    return NextResponse.json({ source });
  });
}

export async function DELETE(_request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { id } = await params;
    // Rows it discovered stay: the FK is ON DELETE SET NULL, so deleting a
    // source stops the polling without throwing away the data it found.
    const removed = await deleteSource(id);
    if (!removed) return notFound("Source");
    return NextResponse.json({ deleted: true });
  });
}
