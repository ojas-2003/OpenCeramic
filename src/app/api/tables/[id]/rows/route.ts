import { NextResponse } from "next/server";
import { z } from "zod";

import { createRows, getTable } from "@/db/queries";
import { handle, notFound, parseBody } from "@/lib/api";

const bodySchema = z.object({
  rows: z.array(z.record(z.string(), z.string())).min(1).max(1000),
});

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  return handle(async () => {
    const { id: tableId } = await params;
    const { data, error } = await parseBody(request, bodySchema);
    if (error) return error;

    if (!(await getTable(tableId))) return notFound("Table");

    const rows = await createRows(tableId, data.rows);
    return NextResponse.json({ rows, created: rows.length }, { status: 201 });
  });
}
