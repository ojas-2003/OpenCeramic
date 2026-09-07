import { NextResponse } from "next/server";
import { z } from "zod";

import { createTable, listTables } from "@/db/queries";
import { apiError, handle, parseBody } from "@/lib/api";

const createSchema = z.object({
  name: z.string().min(1).max(200),
  entity_type: z.enum(["person", "company"]),
});

export async function GET(): Promise<NextResponse> {
  return handle(async () => NextResponse.json({ tables: await listTables() }));
}

export async function POST(request: Request): Promise<NextResponse> {
  return handle(async () => {
    const { data, error } = await parseBody(request, createSchema);
    if (error) return error;
    const table = await createTable(data.name, data.entity_type);
    return NextResponse.json({ table }, { status: 201 });
  });
}

export { apiError };
