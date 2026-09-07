import { NextResponse } from "next/server";

import { cacheStats, cacheTtlSeconds, clearCache } from "@/engine/cache";
import { handle } from "@/lib/api";

export async function GET(): Promise<NextResponse> {
  return handle(async () =>
    NextResponse.json({
      ...(await cacheStats()),
      ttlSeconds: cacheTtlSeconds(),
      maxCreditsPerRun: Number(process.env.MAX_CREDITS_PER_RUN) || 2000,
    }),
  );
}

export async function DELETE(): Promise<NextResponse> {
  return handle(async () => NextResponse.json({ cleared: await clearCache() }));
}
