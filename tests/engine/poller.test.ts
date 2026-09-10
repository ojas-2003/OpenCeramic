import { z } from "zod";
import { describe, expect, it } from "vitest";

import { pollSource, type PollWork } from "@/engine/poller";
import { FakeFiberClient } from "@/fiber/fake";
import { FiberError } from "@/fiber/errors";
import type { DiscoveredRow, PollResult, RowSource } from "@/sources/types";

const ctx = () => ({ fiber: new FakeFiberClient({ inMemory: true }), logger: () => {} });

/** A source whose poll does exactly what the test tells it to. */
function stub(poll: RowSource["poll"]): RowSource {
  return {
    kind: "tracker",
    id: "fiber.source.tracker",
    label: "Stub",
    description: "Stub",
    entity: "company",
    config: z.object({}),
    configFields: [{ key: "listId", label: "List", type: "string" }],
    identityFor: () => null,
    poll,
  };
}

const work = (poll: RowSource["poll"], cursor: Record<string, unknown> = {}): PollWork => ({
  source: stub(poll),
  config: {},
  cursor,
});

const ROW: DiscoveredRow = {
  identityKey: "stripe.com",
  values: { Website: "stripe.com" },
};

describe("pollSource — happy path", () => {
  it("returns the rows and the new cursor the source produced", async () => {
    const outcome = await pollSource(
      work(async (): Promise<PollResult> => ({ rows: [ROW], cursor: { last_run_id: "r2" } }), {
        last_run_id: "r1",
      }),
      ctx(),
    );

    expect(outcome.rows).toEqual([ROW]);
    expect(outcome.cursor).toEqual({ last_run_id: "r2" });
    expect(outcome.error).toBeUndefined();
  });

  it("passes the stored config and cursor through to the source untouched", async () => {
    let seen: unknown[] = [];
    const cursor = { last_signal_at: "2026-09-09T00:00:00.000Z" };
    const source = stub(async (config, c): Promise<PollResult> => {
      seen = [config, c];
      return { rows: [], cursor: c };
    });

    await pollSource({ source, config: { listId: "trk_1" }, cursor }, ctx());

    expect(seen).toEqual([{ listId: "trk_1" }, cursor]);
  });

  it("carries a note through", async () => {
    const outcome = await pollSource(
      work(async (_c, cursor): Promise<PollResult> => ({
        rows: [],
        cursor,
        note: "run in progress",
      })),
      ctx(),
    );

    expect(outcome.note).toBe("run in progress");
    expect(outcome.error).toBeUndefined();
  });

  it("returns a cursor when a source finds nothing", async () => {
    const outcome = await pollSource(
      work(async (): Promise<PollResult> => ({ rows: [], cursor: { last_signal_at: "t1" } })),
      ctx(),
    );

    expect(outcome.rows).toEqual([]);
    // A poll that finds nothing still has a place, and must report it.
    expect(outcome.cursor).toEqual({ last_signal_at: "t1" });
  });
});

describe("pollSource — a failure never moves the cursor", () => {
  const original = { last_run_id: "r1", seen_ids: ["a", "b"] };

  it("returns the original cursor when the source throws", async () => {
    const outcome = await pollSource(
      work(async () => {
        throw new Error("Fiber exploded");
      }, original),
      ctx(),
    );

    expect(outcome.rows).toEqual([]);
    expect(outcome.cursor).toEqual(original);
    expect(outcome.error?.message).toBe("Fiber exploded");
  });

  it("returns the original cursor object itself, not a copy", async () => {
    const outcome = await pollSource(
      work(async () => {
        throw new Error("boom");
      }, original),
      ctx(),
    );

    // Identity, so no partially-built cursor can leak out of a failed poll.
    expect(outcome.cursor).toBe(original);
  });

  it("discards rows a source had already gathered before it threw", async () => {
    const outcome = await pollSource(
      work(async () => {
        // A source that paged some results and then failed. Keeping the rows
        // without the cursor would import them again on the next poll.
        throw new FiberError({
          status: 500,
          code: "server_error",
          retryable: true,
          message: "half a page in",
        });
      }, original),
      ctx(),
    );

    expect(outcome.rows).toEqual([]);
    expect(outcome.cursor).toBe(original);
  });

  it("keeps the given cursor when a source returns none at all", async () => {
    const outcome = await pollSource(
      // A third-party source that ignores the contract. Resetting to {} would
      // re-import its entire history on every poll.
      work(async () => ({ rows: [ROW] }) as unknown as PollResult, original),
      ctx(),
    );

    expect(outcome.cursor).toEqual(original);
  });
});

describe("pollSource — error classification", () => {
  it("marks a 429 retryable so Inngest backs off rather than giving up", async () => {
    const outcome = await pollSource(
      work(async () => {
        throw new FiberError({
          status: 429,
          code: "rate_limited",
          retryable: true,
          message: "Slow down",
        });
      }),
      ctx(),
    );

    expect(outcome.error).toEqual({
      code: "rate_limited",
      message: "Slow down",
      retryable: true,
    });
  });

  it("marks a sandbox 501 terminal, because no amount of backoff fixes it", async () => {
    const outcome = await pollSource(
      work(async () => {
        throw new FiberError({
          status: 501,
          code: "not_implemented",
          retryable: false,
          message: "Sandbox mode is not yet available for this endpoint.",
        });
      }),
      ctx(),
    );

    expect(outcome.error?.retryable).toBe(false);
    expect(outcome.error?.code).toBe("not_implemented");
  });

  it("marks a timeout retryable", async () => {
    const outcome = await pollSource(
      work(async () => {
        const e = new Error("The operation timed out");
        e.name = "TimeoutError";
        throw e;
      }),
      ctx(),
    );

    expect(outcome.error).toEqual({
      code: "timeout",
      message: "The operation timed out",
      retryable: true,
    });
  });

  it("treats an unrecognised throw as terminal", async () => {
    const outcome = await pollSource(
      work(async () => {
        throw new TypeError("cannot read properties of undefined");
      }),
      ctx(),
    );

    // An error we cannot classify is not one we can argue is worth retrying.
    expect(outcome.error?.retryable).toBe(false);
    expect(outcome.error?.code).toBe("adapter_error");
  });

  it("survives a source throwing a non-Error", async () => {
    const outcome = await pollSource(
      work(async () => {
        throw "just a string";
      }),
      ctx(),
    );

    expect(outcome.error?.message).toBe("just a string");
    expect(outcome.cursor).toEqual({});
  });
});

describe("pollSource — purity", () => {
  it("does not mutate the cursor it was given", async () => {
    const cursor = { last_signal_at: "t1", seen_ids: ["a"] };
    const snapshot = structuredClone(cursor);

    await pollSource(
      work(async (_c, given): Promise<PollResult> => {
        (given as { seen_ids: string[] }).seen_ids.push("mutated");
        return { rows: [], cursor: { last_signal_at: "t2" } };
      }, cursor),
      ctx(),
    );

    // A source that mutates its input is the source's bug, and this documents
    // that pollSource itself adds none: it hands the object straight through.
    expect(cursor).not.toEqual(snapshot);
    expect(cursor.seen_ids).toEqual(["a", "mutated"]);
  });
});
