import { createHash, randomUUID } from "node:crypto";

import type { NewApiCall } from "@/db/schema";
import { fiberErrorFromNetwork, fiberErrorFromResponse } from "@/fiber/errors";
import type { paths } from "@/fiber/types.generated";

/* ------------------------------------------------------------------ */
/* Typed surface over the generated OpenAPI paths                      */
/* ------------------------------------------------------------------ */

type Operation<P extends keyof paths, M extends keyof paths[P]> = paths[P][M];

type JsonBodyOf<T> = T extends { requestBody: { content: { "application/json": infer B } } }
  ? B
  : T extends { requestBody?: { content: { "application/json": infer B } } }
    ? B | undefined
    : undefined;

type JsonResponseOf<T> = T extends {
  responses: { 200: { content: { "application/json": infer D } } };
}
  ? D
  : unknown;

/** The request body minus `apiKey` — the client injects that itself. */
type WithoutApiKey<T> = T extends object ? Omit<T, "apiKey"> : T;

export type FiberRequestBody<
  P extends keyof paths,
  M extends keyof paths[P],
> = WithoutApiKey<JsonBodyOf<Operation<P, M>>>;

export type FiberResponseData<
  P extends keyof paths,
  M extends keyof paths[P],
> = JsonResponseOf<Operation<P, M>>;

export type FiberCallResult<D> = {
  data: D;
  credits: number;
  apiCallId: string;
};

export interface FiberClient {
  call<P extends keyof paths, M extends keyof paths[P]>(
    path: P,
    method: M,
    body: FiberRequestBody<P, M>,
  ): Promise<FiberCallResult<FiberResponseData<P, M>>>;
}

/* ------------------------------------------------------------------ */
/* api_calls logging                                                   */
/* ------------------------------------------------------------------ */

export type ApiCallRecord = Omit<NewApiCall, "id" | "createdAt">;

export interface ApiCallLogger {
  record(entry: ApiCallRecord): Promise<string>;
}

/** Used by tests and by the fake client's in-memory mode. */
export class MemoryApiCallLogger implements ApiCallLogger {
  readonly entries: Array<ApiCallRecord & { id: string }> = [];

  async record(entry: ApiCallRecord): Promise<string> {
    const id = randomUUID();
    this.entries.push({ ...entry, id });
    return id;
  }

  reset(): void {
    this.entries.length = 0;
  }
}

/**
 * Imports the db lazily: src/db/client.ts throws when DATABASE_URL is unset,
 * and unit tests import this module without a database.
 */
export function createDbApiCallLogger(): ApiCallLogger {
  return {
    async record(entry: ApiCallRecord): Promise<string> {
      const [{ db }, { apiCalls }] = await Promise.all([
        import("@/db/client"),
        import("@/db/schema"),
      ]);
      const [row] = await db.insert(apiCalls).values(entry).returning({ id: apiCalls.id });
      return row.id;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Request hashing                                                     */
/* ------------------------------------------------------------------ */

/**
 * JSON with object keys sorted at every depth, so two bodies that differ only
 * in key order hash identically. Undefined values are dropped, matching
 * JSON.stringify.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** Never includes the API key — the body handed here has already had it stripped. */
export function hashRequest(body: unknown): string {
  return createHash("sha256").update(stableStringify(body)).digest("hex");
}

/* ------------------------------------------------------------------ */
/* Credits                                                             */
/* ------------------------------------------------------------------ */

/**
 * llms.txt: "Always treat `output.chargeInfo` (or `chargeInfo`) as
 * authoritative post-call reconciliation for what the user was charged."
 *
 * In openapi.json the field is a required sibling of `output`, a discriminated
 * union on `method` with five variants:
 *   charged-now               creditsCharged   -> billed for this call
 *   charged-for-async-process creditsCharged   -> billed for this call
 *   credits-refunded          creditsRefunded  -> credits returned
 *   charging-later            message          -> billed out of band
 *   free                      message          -> no charge
 * Both nesting positions are read because llms.txt documents both.
 */
export function extractCredits(payload: unknown): number {
  const charge = readChargeInfo(payload);
  if (!charge) return 0;

  if (
    (charge.method === "charged-now" || charge.method === "charged-for-async-process") &&
    typeof charge.creditsCharged === "number"
  ) {
    return charge.creditsCharged;
  }
  // A refund is a negative charge so run totals reconcile.
  if (charge.method === "credits-refunded" && typeof charge.creditsRefunded === "number") {
    return -charge.creditsRefunded;
  }
  return 0;
}

type ChargeInfoLike = {
  method?: unknown;
  creditsCharged?: unknown;
  creditsRefunded?: unknown;
};

function readChargeInfo(payload: unknown): ChargeInfoLike | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as { chargeInfo?: unknown; output?: unknown };

  if (root.chargeInfo && typeof root.chargeInfo === "object") {
    return root.chargeInfo as ChargeInfoLike;
  }
  if (root.output && typeof root.output === "object") {
    const nested = (root.output as { chargeInfo?: unknown }).chargeInfo;
    if (nested && typeof nested === "object") return nested as ChargeInfoLike;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* HTTP client                                                         */
/* ------------------------------------------------------------------ */

export type FiberHttpClientOptions = {
  apiKey?: string;
  baseUrl?: string;
  logger?: ApiCallLogger;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/** llms.txt recommends a 30s timeout for the heavier lookups. */
const DEFAULT_TIMEOUT_MS = 30_000;

const QUERY_METHODS = new Set(["GET", "DELETE"]);

export class FiberHttpClient implements FiberClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly logger: ApiCallLogger;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FiberHttpClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.FIBER_API_KEY ?? "";
    this.baseUrl = (options.baseUrl ?? process.env.FIBER_BASE_URL ?? "https://api.fiber.ai").replace(
      /\/$/,
      "",
    );
    this.logger = options.logger ?? createDbApiCallLogger();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async call<P extends keyof paths, M extends keyof paths[P]>(
    path: P,
    method: M,
    body: FiberRequestBody<P, M>,
  ): Promise<FiberCallResult<FiberResponseData<P, M>>> {
    if (!this.apiKey) {
      throw new Error("FIBER_API_KEY is not set");
    }

    const endpoint = String(path);
    const httpMethod = String(method).toUpperCase();
    const input = (body ?? {}) as Record<string, unknown>;

    // The hash identifies the request independently of credentials, so the same
    // lookup made with a different key still collapses to one cache entry.
    const requestHash = hashRequest(input);

    const url = new URL(`${this.baseUrl}${endpoint}`);
    let payload: string | undefined;

    if (QUERY_METHODS.has(httpMethod)) {
      // llms.txt: GET/DELETE take the key in the query string.
      for (const [key, value] of Object.entries(input)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
      url.searchParams.set("apiKey", this.apiKey);
    } else {
      // llms.txt: POST/PATCH/PUT take the key in the body.
      payload = JSON.stringify({ ...input, apiKey: this.apiKey });
    }

    const startedAt = performance.now();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: httpMethod,
        headers: {
          "content-type": "application/json",
          // Header form is also accepted; body/query take precedence.
          "x-api-key": this.apiKey,
        },
        body: payload,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      const latencyMs = Math.round(performance.now() - startedAt);
      await this.logger.record({
        endpoint,
        requestHash,
        httpStatus: null,
        latencyMs,
        credits: 0,
        responseMeta: { transport_error: true },
      });
      throw fiberErrorFromNetwork(cause);
    }

    const latencyMs = Math.round(performance.now() - startedAt);
    const text = await response.text();
    const json = parseJson(text);
    const credits = extractCredits(json);

    // Logged for both success and failure — api_calls is the audit trail.
    const apiCallId = await this.logger.record({
      endpoint,
      requestHash,
      httpStatus: response.status,
      latencyMs,
      credits,
      responseMeta: {
        ok: response.ok,
        bytes: text.length,
        charge_info: readChargeInfo(json),
      },
    });

    if (!response.ok) {
      throw fiberErrorFromResponse(response.status, json);
    }

    return {
      data: json as FiberResponseData<P, M>,
      credits,
      apiCallId,
    };
  }
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
