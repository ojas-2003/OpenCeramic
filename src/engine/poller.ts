import { toAdapterError } from "@/engine/errors";
import type { Ctx } from "@/enrichments/types";
import type { DiscoveredRow, RowSource } from "@/sources/types";

/**
 * The pure half of polling, mirroring processWork in src/engine/process.ts: no
 * database, no Inngest, no clock. Hand it a source and a cursor and it tells you
 * what it found and where it got to, which is what makes the cursor rules
 * testable without a table to poll into.
 */

export interface PollWork {
  source: RowSource;
  config: unknown;
  cursor: Record<string, unknown>;
}

export interface PollOutcome {
  rows: DiscoveredRow[];
  cursor: Record<string, unknown>;
  note?: string;
  error?: { code: string; message: string; retryable: boolean };
}

/**
 * The one rule this function exists to enforce: **a failed poll returns the
 * cursor it was given.** A cursor that advances past results nobody read loses
 * those rows permanently — there is no second chance, because the next poll
 * asks only for what came after. So every failure path here returns
 * `work.cursor` by identity, never a derived or partial one.
 */
export async function pollSource(work: PollWork, ctx: Ctx): Promise<PollOutcome> {
  try {
    const result = await work.source.poll(work.config, work.cursor, ctx);

    return {
      rows: result?.rows ?? [],
      // A source that returns no cursor at all keeps the one it was given, for
      // the same reason: silently resetting to {} would re-import everything.
      cursor: result?.cursor ?? work.cursor,
      ...(result?.note ? { note: result.note } : {}),
    };
  } catch (e) {
    return {
      rows: [],
      cursor: work.cursor,
      error: toAdapterError(e),
    };
  }
}
