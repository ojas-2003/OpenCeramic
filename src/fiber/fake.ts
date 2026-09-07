import emailBounceDetection from "@/fiber/fixtures/emailBounceDetection.json";
import getOrgCredits from "@/fiber/fixtures/getOrgCredits.json";
import getRateLimits from "@/fiber/fixtures/getRateLimits.json";
import getCompanyRevenue from "@/fiber/fixtures/getCompanyRevenue.json";
import kitchenSinkCompany from "@/fiber/fixtures/kitchenSinkCompany.json";
import peopleSearch from "@/fiber/fixtures/peopleSearch.json";
import pollBatchContactDetails from "@/fiber/fixtures/pollBatchContactDetails.json";
import socialMediaLookupPolling from "@/fiber/fixtures/socialMediaLookupPolling.json";
import socialMediaLookupTrigger from "@/fiber/fixtures/socialMediaLookupTrigger.json";
import startBatchContactDetails from "@/fiber/fixtures/startBatchContactDetails.json";

import {
  createDbApiCallLogger,
  extractCredits,
  hashRequest,
  MemoryApiCallLogger,
  type ApiCallLogger,
  type FiberCallResult,
  type FiberClient,
  type FiberRequestBody,
  type FiberResponseData,
} from "@/fiber/client";
import { FiberError } from "@/fiber/errors";
import type { paths } from "@/fiber/types.generated";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

export type FiberFixture = {
  operationId: string;
  path: string;
  method: string;
  creditCost: number;
  /** Keyed by request hash, or "*" for any request. */
  responses: Record<string, unknown>;
  notFound: unknown;
};

const FIXTURES: FiberFixture[] = [
  kitchenSinkCompany,
  getCompanyRevenue,
  peopleSearch,
  startBatchContactDetails,
  pollBatchContactDetails,
  emailBounceDetection,
  socialMediaLookupTrigger,
  socialMediaLookupPolling,
  getOrgCredits,
  getRateLimits,
] as FiberFixture[];

const BY_PATH = new Map(FIXTURES.map((f) => [f.path, f]));

export function getFixture(path: string): FiberFixture | undefined {
  return BY_PATH.get(path);
}

export function listFixtures(): FiberFixture[] {
  return [...FIXTURES];
}

/* ------------------------------------------------------------------ */
/* Programmable behaviour                                              */
/* ------------------------------------------------------------------ */

export type FakeBehaviour =
  | { kind: "fixture"; key?: string }
  /** Fiber found nothing. Still a successful call — see CLAUDE.md. */
  | { kind: "not_found" }
  /** Fail `failures` times with a retryable error, then serve the fixture. */
  | { kind: "retry_then_succeed"; failures: number; status?: number }
  | { kind: "terminal"; status?: number; code?: string; message?: string };

export type FakeFiberClientOptions = {
  /** Skip the database and keep api_calls in memory. Defaults to on under test. */
  inMemory?: boolean;
  logger?: ApiCallLogger;
};

/**
 * Stands in for the real client in tests and in FIBER_FAKE=1 dev. It honours the
 * same interface, logs api_calls the same way, and computes credits with the
 * same extractor, so behaviour differences stay in the transport only.
 */
export class FakeFiberClient implements FiberClient {
  readonly memoryLog: MemoryApiCallLogger;
  private readonly logger: ApiCallLogger;
  private readonly behaviours = new Map<string, FakeBehaviour>();
  private readonly attemptCounts = new Map<string, number>();

  constructor(options: FakeFiberClientOptions = {}) {
    const inMemory = options.inMemory ?? process.env.NODE_ENV === "test";
    this.memoryLog = new MemoryApiCallLogger();
    this.logger = options.logger ?? (inMemory ? this.memoryLog : createDbApiCallLogger());
  }

  /** Set how a given path behaves for subsequent calls. */
  program(path: string, behaviour: FakeBehaviour): void {
    this.behaviours.set(path, behaviour);
  }

  reset(): void {
    this.behaviours.clear();
    this.attemptCounts.clear();
    this.memoryLog.reset();
  }

  attempts(path: string): number {
    return this.attemptCounts.get(path) ?? 0;
  }

  async call<P extends keyof paths, M extends keyof paths[P]>(
    path: P,
    method: M,
    body: FiberRequestBody<P, M>,
  ): Promise<FiberCallResult<FiberResponseData<P, M>>> {
    const endpoint = String(path);
    const fixture = BY_PATH.get(endpoint);
    if (!fixture) {
      throw new Error(`No Fiber fixture for ${endpoint}. Add src/fiber/fixtures/<operationId>.json`);
    }

    const input = (body ?? {}) as Record<string, unknown>;
    const requestHash = hashRequest(input);
    const attempt = (this.attemptCounts.get(endpoint) ?? 0) + 1;
    this.attemptCounts.set(endpoint, attempt);

    const behaviour = this.behaviours.get(endpoint) ?? { kind: "fixture" };

    if (behaviour.kind === "terminal") {
      const status = behaviour.status ?? 400;
      await this.log(endpoint, requestHash, status, 0, { simulated: "terminal" });
      throw new FiberError({
        status,
        code: behaviour.code ?? "bad_request",
        retryable: false,
        message: behaviour.message ?? `Simulated terminal error for ${endpoint}`,
      });
    }

    if (behaviour.kind === "retry_then_succeed" && attempt <= behaviour.failures) {
      const status = behaviour.status ?? 429;
      await this.log(endpoint, requestHash, status, 0, { simulated: "retryable", attempt });
      throw new FiberError({
        status,
        code: status === 429 ? "rate_limited" : "server_error",
        retryable: true,
        message: `Simulated retryable error for ${endpoint} (attempt ${attempt})`,
      });
    }

    const payload =
      behaviour.kind === "not_found"
        ? fixture.notFound
        : (fixture.responses[behaviour.kind === "fixture" && behaviour.key ? behaviour.key : requestHash] ??
          fixture.responses["*"]);

    if (payload === undefined) {
      throw new Error(`Fixture for ${endpoint} has no response for hash ${requestHash} or "*"`);
    }

    const credits = extractCredits(payload);
    const apiCallId = await this.log(endpoint, requestHash, 200, credits, {
      ok: true,
      fixture: fixture.operationId,
    });

    return { data: payload as FiberResponseData<P, M>, credits, apiCallId };
  }

  private log(
    endpoint: string,
    requestHash: string,
    httpStatus: number,
    credits: number,
    responseMeta: Record<string, unknown>,
  ): Promise<string> {
    return this.logger.record({
      endpoint,
      requestHash,
      httpStatus,
      latencyMs: 0,
      credits,
      responseMeta,
    });
  }
}
