import { NextResponse } from "next/server";

import { getFiberClient } from "@/fiber";
import { FiberError } from "@/fiber/errors";
import { handle } from "@/lib/api";

type Account = {
  credits: unknown | null;
  rate_limits: unknown | null;
  /** Set when Fiber declined to answer, e.g. a sandbox key. */
  unavailable?: { credits?: string; rate_limits?: string };
};

const TTL_MS = 60_000;
let cached: { at: number; value: Account } | null = null;

export async function GET(): Promise<NextResponse> {
  return handle(async () => {
    if (cached && Date.now() - cached.at < TTL_MS) {
      return NextResponse.json({ ...cached.value, cached: true });
    }

    const fiber = getFiberClient();
    const [credits, limits] = await Promise.all([
      attempt(() => fiber.call("/v1/get-org-credits", "get", undefined)),
      attempt(() => fiber.call("/v1/rate-limits", "get", undefined)),
    ]);

    const value: Account = { credits: credits.data, rate_limits: limits.data };
    const unavailable: Record<string, string> = {};
    if (credits.reason) unavailable.credits = credits.reason;
    if (limits.reason) unavailable.rate_limits = limits.reason;
    if (Object.keys(unavailable).length > 0) value.unavailable = unavailable;

    cached = { at: Date.now(), value };
    return NextResponse.json({ ...value, cached: false });
  });
}

/**
 * Both endpoints return 501 on a sandbox key. A missing balance must not break
 * the page, so failures degrade to null with the reason attached.
 */
async function attempt(
  call: () => Promise<{ data: unknown }>,
): Promise<{ data: unknown | null; reason?: string }> {
  try {
    return { data: (await call()).data };
  } catch (e) {
    if (e instanceof FiberError) return { data: null, reason: `${e.code}: ${e.message}` };
    return { data: null, reason: e instanceof Error ? e.message : String(e) };
  }
}
