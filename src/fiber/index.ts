import { FiberHttpClient, type FiberClient } from "@/fiber/client";
import { FakeFiberClient } from "@/fiber/fake";

export type {
  ApiCallLogger,
  FiberCallResult,
  FiberClient,
  FiberRequestBody,
  FiberResponseData,
} from "@/fiber/client";
export { FiberHttpClient, MemoryApiCallLogger, extractCredits, hashRequest, stableStringify } from "@/fiber/client";
export { FakeFiberClient, getFixture, listFixtures } from "@/fiber/fake";
export { FiberError, isRetryable } from "@/fiber/errors";

/**
 * The only place that decides which client the app talks to. Everything else
 * takes a FiberClient as a dependency.
 */
export function getFiberClient(): FiberClient {
  if (process.env.FIBER_FAKE === "1" || process.env.NODE_ENV === "test") {
    return new FakeFiberClient();
  }
  return new FiberHttpClient();
}
