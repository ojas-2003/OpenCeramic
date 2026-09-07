import { NextResponse } from "next/server";
import type { z } from "zod";

/** Every error response has the same shape: { error: { code, message } }. */
export function apiError(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json({ error: { code, message, ...(details ? { details } : {}) } }, { status });
}

export const notFound = (what: string) => apiError(404, "not_found", `${what} not found`);

/** Parses a JSON body with Zod, returning either the value or a 400 response. */
export async function parseBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<{ data: T; error: null } | { data: null; error: NextResponse }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { data: null, error: apiError(400, "invalid_json", "Request body is not valid JSON") };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      data: null,
      error: apiError(
        400,
        "invalid_body",
        parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      ),
    };
  }
  return { data: parsed.data, error: null };
}

/** Wraps a handler so an unexpected throw becomes a 500 with our error shape. */
export async function handle(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return apiError(500, "internal_error", message);
  }
}
