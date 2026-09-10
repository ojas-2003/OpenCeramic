import type { z } from "zod";

import type { Ctx, FieldSpec } from "@/enrichments/types";

/**
 * The row source contract, deliberately shaped like the enrichment contract in
 * src/enrichments/types.ts: one interface, one file per source, a registry the
 * engine resolves through. The difference is what they produce — a source
 * discovers entities and creates rows, an enrichment fills cells. Neither does
 * the other's job (CLAUDE.md, "Row sources").
 */

/** One entity a source found. Not yet known to be new — the DB decides that. */
export interface DiscoveredRow {
  identityKey: string; // normalized; the dedupe key
  values: Record<string, string>; // input column name -> value, e.g. { Website: "stripe.com" }
  signal?: { kind: string; reason: string; occurred_at: string; raw_id?: string };
}

export interface PollResult {
  rows: DiscoveredRow[];
  cursor: Record<string, unknown>; // replaces the stored cursor on success
  note?: string; // surfaced in the UI, e.g. "run still building"
}

export interface RowSource<C = unknown> {
  kind: "saved_search" | "tracker";
  id: string; // "fiber.source.savedSearch"
  label: string;
  description: string;
  entity: "person" | "company";
  config: z.ZodType<C>; // validated when a source is created
  configFields: FieldSpec[]; // drives the create-source form
  identityFor(item: unknown): string | null; // null means skip the item
  poll(config: C, cursor: Record<string, unknown>, ctx: Ctx): Promise<PollResult>;
  setup?(config: C, ctx: Ctx): Promise<Partial<C>>; // optional: create the Fiber-side object, return ids to merge into config
}

/**
 * The registry holds sources with unrelated config types, so it needs a common
 * supertype. Only the registry and the poller use this; sources stay precise.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRowSource = RowSource<any>;

/** Sources are always exactly one entity — there is no "any", unlike enrichments. */
export type SourceEntity = AnyRowSource["entity"];

/** Re-exported so a source file imports its whole contract from one module. */
export type { Ctx, FieldSpec };
