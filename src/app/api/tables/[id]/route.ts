import { NextResponse } from "next/server";

import { deleteTable, getTableWithData } from "@/db/queries";
import { handle, notFound } from "@/lib/api";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { id } = await params;
    const data = await getTableWithData(id);
    if (!data) return notFound("Table");
    // Cells come back as a flat array; the client indexes them.
    return NextResponse.json(data);
  });
}

export async function DELETE(_request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { id } = await params;
    const removed = await deleteTable(id);
    if (!removed) return notFound("Table");
    return NextResponse.json({ deleted: true });
  });
}
