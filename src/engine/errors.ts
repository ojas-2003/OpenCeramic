import type { AdapterError } from "@/enrichments/types";
import { FiberError } from "@/fiber/errors";

/**
 * Normalises anything thrown during a cell's execution into the shape the
 * executor records. FiberError already carries code/message/retryable, so it
 * passes through; everything else is terminal, because an error we do not
 * recognise is not one we can argue is worth retrying.
 */
export function toAdapterError(e: unknown): AdapterError {
  if (e instanceof FiberError) {
    return { code: e.code, message: e.message, retryable: e.retryable };
  }

  // An adapter may return or throw a bare AdapterError.
  if (isAdapterErrorShape(e)) {
    return { code: e.code, message: e.message, retryable: e.retryable };
  }

  if (e instanceof Error) {
    const retryable = e.name === "AbortError" || e.name === "TimeoutError";
    return {
      code: retryable ? "timeout" : "adapter_error",
      message: e.message || e.name,
      retryable,
    };
  }

  return { code: "adapter_error", message: String(e), retryable: false };
}

export function isAdapterErrorShape(e: unknown): e is AdapterError {
  if (!e || typeof e !== "object") return false;
  const c = e as Record<string, unknown>;
  return (
    typeof c.code === "string" &&
    typeof c.message === "string" &&
    typeof c.retryable === "boolean"
  );
}
