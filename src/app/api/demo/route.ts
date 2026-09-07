import { NextResponse } from "next/server";

import { seedDemoTable } from "@/db/seed";
import { handle } from "@/lib/api";

/** "Load demo table" on the home page. */
export async function POST(): Promise<NextResponse> {
  return handle(async () => {
    const result = await seedDemoTable();
    return NextResponse.json(result, { status: 201 });
  });
}
