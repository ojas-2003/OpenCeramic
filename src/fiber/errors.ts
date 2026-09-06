/**
 * Error taxonomy for Fiber calls.
 *
 * The retryable/terminal split is the contract the executor depends on
 * (DESIGN.md section 4.3): retryable errors go back through Inngest's backoff,
 * terminal errors mark the cell failed and stop.
 *
 * Status meanings are from https://api.fiber.ai/llms.txt ("Error handling"):
 *   400 invalid request · 401 invalid API key · 402 out of credits
 *   429 rate limited    · 500 server error
 */

export type FiberErrorInit = {
  status: number;
  code: string;
  retryable: boolean;
  message: string;
  cause?: unknown;
};

export class FiberError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(init: FiberErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "FiberError";
    this.status = init.status;
    this.code = init.code;
    this.retryable = init.retryable;
  }
}

/** Retryable: 429, any 5xx, and transport-level failures (network, timeout). */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function defaultCodeFor(status: number): string {
  if (status === 400) return "bad_request";
  if (status === 401) return "unauthorized";
  if (status === 402) return "out_of_credits";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "http_error";
}

/** Pull Fiber's own error code/message out of a response body when present. */
function readErrorBody(body: unknown): { code?: string; message?: string } {
  if (!body || typeof body !== "object") return {};
  const b = body as Record<string, unknown>;
  const code =
    typeof b.errorCode === "string"
      ? b.errorCode
      : typeof b.code === "string"
        ? b.code
        : undefined;
  const message =
    typeof b.message === "string"
      ? b.message
      : typeof b.error === "string"
        ? b.error
        : undefined;
  return { code, message };
}

export function fiberErrorFromResponse(status: number, body: unknown): FiberError {
  const { code, message } = readErrorBody(body);
  return new FiberError({
    status,
    code: code ?? defaultCodeFor(status),
    retryable: isRetryableStatus(status),
    message: message ?? `Fiber request failed with status ${status}`,
  });
}

/**
 * fetch() rejects for DNS failures, connection resets and aborts. All of those
 * are worth another attempt, so they map to status 0 with retryable=true.
 */
export function fiberErrorFromNetwork(cause: unknown): FiberError {
  const isAbort =
    cause instanceof Error &&
    (cause.name === "AbortError" || cause.name === "TimeoutError");
  return new FiberError({
    status: 0,
    code: isAbort ? "timeout" : "network_error",
    retryable: true,
    message:
      cause instanceof Error ? cause.message : "Fiber request failed before a response",
    cause,
  });
}

export function isRetryable(e: unknown): boolean {
  if (e instanceof FiberError) return e.retryable;
  // A raw fetch rejection that never made it through fiberErrorFromNetwork.
  if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) {
    return true;
  }
  return false;
}
