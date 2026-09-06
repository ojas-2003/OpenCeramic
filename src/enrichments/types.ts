import type { z } from "zod";

import type { FiberClient } from "@/fiber/client";

export type RunMode = "sync" | "async" | "batch";
export type EntityType = "person" | "company" | "any";

export interface FieldSpec {
  key: string;
  label: string;
  type: "string" | "number" | "url" | "email" | "json";
}

export interface AdapterError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface Ctx {
  fiber: FiberClient;
  logger: (msg: string, meta?: object) => void;
}

export type PollResult<O> =
  | { state: "pending" }
  | { state: "done"; value: O | null }
  | { state: "failed"; error: AdapterError };

export interface Enrichment<I = unknown, O = unknown> {
  id: string;
  version: number;
  label: string;
  description: string;
  entity: EntityType;
  mode: RunMode;
  inputs: z.ZodType<I>;
  output: z.ZodType<O>;
  outputFields: FieldSpec[];
  estimateCredits(input: I): number;
  cacheKey(input: I): string;
  ttlSeconds?: number;
  concurrency?: number; // default 5
  batchSize?: number; // batch mode only, default 25
  run?(input: I, ctx: Ctx): Promise<O | null>;
  runBatch?(inputs: I[], ctx: Ctx): Promise<Array<O | null | AdapterError>>;
  start?(input: I, ctx: Ctx): Promise<{ handle: string }>;
  poll?(handle: string, ctx: Ctx): Promise<PollResult<O>>;
}

/**
 * The registry holds adapters with unrelated I/O types, so it needs a common
 * supertype. Only the registry and the engine use this; adapters stay precise.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEnrichment = Enrichment<any, any>;
