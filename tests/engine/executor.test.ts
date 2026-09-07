import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { Cell } from "@/db/schema";
import { MemoryCache } from "@/engine/cache";
import { toAdapterError } from "@/engine/errors";

import { parseSourceRef, readSourceValue } from "@/engine/sourceRef";
import {
  chunk,
  countCells,
  mapWithConcurrency,
  MAX_POLLS,
  processBatchChunk,
  processChunk,
  processAsyncCell,
  resolveCells,
  type CellWork,
  type ProcessDeps,
} from "@/engine/process";
import type { AdapterError, AnyEnrichment, PollResult } from "@/enrichments/types";
import { FakeFiberClient } from "@/fiber/fake";
import { FiberError } from "@/fiber/errors";

const KITCHEN_SINK = "/v1/kitchen-sink/company";

/* ------------------------------------------------------------------ */
/* Test doubles                                                        */
/* ------------------------------------------------------------------ */

const anySchema = z.record(z.string(), z.unknown());

type AdapterOverrides = Partial<AnyEnrichment>;

function adapter(overrides: AdapterOverrides = {}): AnyEnrichment {
  return {
    id: "fiber.test.sync",
    version: 1,
    label: "Test",
    description: "Test",
    entity: "company",
    mode: "sync",
    inputs: anySchema,
    output: anySchema,
    outputFields: [],
    estimateCredits: () => 2,
    cacheKey: (input) => `k:${JSON.stringify(input)}`,
    run: async () => ({ ok: true }),
    ...overrides,
  } as AnyEnrichment;
}

function deps(over: Partial<ProcessDeps> = {}): ProcessDeps & { cache: MemoryCache; fiber: FakeFiberClient } {
  const fiber = new FakeFiberClient({ inMemory: true });
  return {
    fiber,
    cache: new MemoryCache(),
    logger: () => {},
    sleep: async () => {}, // no real backoff in tests
    ...over,
  } as ProcessDeps & { cache: MemoryCache; fiber: FakeFiberClient };
}

const work = (rowId: string, input: unknown = { domain: "acme.com" }): CellWork => ({
  rowId,
  columnId: "C",
  input,
});

const cell = (over: Partial<Cell> = {}): Cell => ({
  rowId: "r1",
  columnId: "SRC",
  value: "acme.com",
  status: "done",
  errorCode: null,
  errorMessage: null,
  runId: null,
  provenance: null,
  updatedAt: new Date(),
  ...over,
});

/* ------------------------------------------------------------------ */
/* Input resolution and skip semantics                                 */
/* ------------------------------------------------------------------ */

describe("resolveCells", () => {
  const config = { inputs: { domain: "SRC" } };

  it("passes through a cell whose source is done and non-null", () => {
    const sources = new Map([["r1:SRC", cell()]]);
    const out = resolveCells([{ rowId: "r1", columnId: "C" }], config, adapter(), sources);

    expect(out.blocked).toHaveLength(0);
    expect(out.runnable).toEqual([{ rowId: "r1", columnId: "C", input: { domain: "acme.com" } }]);
  });

  it.each([
    ["failed", "source column failed"],
    ["skipped", "source column was skipped"],
    ["pending", "source column has not run"],
  ])("skips downstream when the source is %s, recording the reason", (status, reason) => {
    const sources = new Map([["r1:SRC", cell({ status: status as Cell["status"] })]]);
    const out = resolveCells([{ rowId: "r1", columnId: "C" }], config, adapter(), sources);

    expect(out.runnable).toHaveLength(0);
    expect(out.blocked[0].status).toBe("skipped");
    expect(out.blocked[0].provenance.skipped_because).toEqual({ column_id: "SRC", reason });
  });

  it("skips when the source value is null — an empty upstream is not runnable", () => {
    const sources = new Map([["r1:SRC", cell({ value: null })]]);
    const out = resolveCells([{ rowId: "r1", columnId: "C" }], config, adapter(), sources);

    expect(out.blocked[0].provenance.skipped_because?.reason).toBe("source value is empty");
  });

  it("skips when the source cell does not exist at all", () => {
    const out = resolveCells([{ rowId: "r1", columnId: "C" }], config, adapter(), new Map());
    expect(out.blocked[0].provenance.skipped_because?.reason).toBe(
      "source cell has not been created",
    );
  });

  it("reads a field out of an enrichment source via the dotted form", () => {
    const sources = new Map([
      ["r1:SRC", cell({ value: { linkedin_url: "https://linkedin.com/company/acme", name: "Acme" } })],
    ]);
    const out = resolveCells(
      [{ rowId: "r1", columnId: "C" }],
      { inputs: { domain: "SRC.linkedin_url" } },
      adapter(),
      sources,
    );

    expect(out.blocked).toHaveLength(0);
    expect(out.runnable[0].input).toEqual({ domain: "https://linkedin.com/company/acme" });
  });

  it("skips when the named field is absent or empty", () => {
    const sources = new Map([["r1:SRC", cell({ value: { name: "Acme", linkedin_url: null } })]]);
    const out = resolveCells(
      [{ rowId: "r1", columnId: "C" }],
      { inputs: { domain: "SRC.linkedin_url" } },
      adapter(),
      sources,
    );

    expect(out.runnable).toHaveLength(0);
    expect(out.blocked[0].provenance.skipped_because).toEqual({
      column_id: "SRC",
      reason: 'source field "linkedin_url" is empty',
    });
  });

  it("skips when a dotted mapping points at a scalar source", () => {
    const sources = new Map([["r1:SRC", cell({ value: "acme.com" })]]);
    const out = resolveCells(
      [{ rowId: "r1", columnId: "C" }],
      { inputs: { domain: "SRC.linkedin_url" } },
      adapter(),
      sources,
    );
    expect(out.blocked[0].provenance.skipped_because?.reason).toBe(
      'source value has no field "linkedin_url"',
    );
  });

  it("fails with invalid_input when the value does not match the adapter schema", () => {
    const strict = adapter({ inputs: z.object({ domain: z.number() }) });
    const sources = new Map([["r1:SRC", cell()]]);
    const out = resolveCells([{ rowId: "r1", columnId: "C" }], config, strict, sources);

    expect(out.runnable).toHaveLength(0);
    expect(out.blocked[0].status).toBe("failed");
    expect(out.blocked[0].errorCode).toBe("invalid_input");
    expect(out.blocked[0].errorMessage).toContain("domain");
  });
});

/* ------------------------------------------------------------------ */
/* sync mode                                                           */
/* ------------------------------------------------------------------ */

describe("processChunk (sync)", () => {
  it("serves a cache hit without calling Fiber", async () => {
    const d = deps();
    const a = adapter({ run: async () => { throw new Error("must not be called"); } });
    await d.cache.set(a.cacheKey({ domain: "acme.com" }), { cached: true }, 2, 60);

    const [out] = await processChunk([work("r1")], a, d);

    expect(out.status).toBe("done");
    expect(out.value).toEqual({ cached: true });
    expect(out.provenance.cache_hit).toBe(true);
    expect(d.fiber.memoryLog.entries).toHaveLength(0);
  });

  it("records a null result as done with value null", async () => {
    const d = deps();
    const [out] = await processChunk([work("r1")], adapter({ run: async () => null }), d);

    expect(out.status).toBe("done");
    expect(out.value).toBeNull();
    expect(out.errorCode).toBeNull();
  });

  it("caches a null result so the same absence is not paid for twice", async () => {
    const d = deps();
    const a = adapter({ run: async () => null });
    await processChunk([work("r1")], a, d);
    expect(d.cache.size).toBe(1);
  });

  it("retries a retryable error twice then succeeds, logging three api_calls", async () => {
    const d = deps();
    d.fiber.program(KITCHEN_SINK, { kind: "retry_then_succeed", failures: 2 });

    const a = adapter({
      run: async (_input, ctx) => {
        await ctx.fiber.call(KITCHEN_SINK, "post", {});
        return { ok: true };
      },
    });

    const [out] = await processChunk([work("r1")], a, d);

    expect(out.status).toBe("done");
    expect(d.fiber.attempts(KITCHEN_SINK)).toBe(3);
    expect(d.fiber.memoryLog.entries).toHaveLength(3);
    expect(d.fiber.memoryLog.entries.map((e) => e.httpStatus)).toEqual([429, 429, 200]);
  });

  it("fails without retrying on a terminal error", async () => {
    const d = deps();
    d.fiber.program(KITCHEN_SINK, { kind: "terminal", status: 400, code: "bad_request" });

    const a = adapter({
      run: async (_input, ctx) => {
        await ctx.fiber.call(KITCHEN_SINK, "post", {});
        return { ok: true };
      },
    });

    const [out] = await processChunk([work("r1")], a, d);

    expect(out.status).toBe("failed");
    expect(out.errorCode).toBe("bad_request");
    expect(d.fiber.attempts(KITCHEN_SINK)).toBe(1);
  });

  it("gives up after three attempts on a persistently retryable error", async () => {
    const d = deps();
    let calls = 0;
    const a = adapter({
      run: async () => {
        calls += 1;
        throw new FiberError({ status: 429, code: "rate_limited", retryable: true, message: "slow down" });
      },
    });

    const [out] = await processChunk([work("r1")], a, d);

    expect(calls).toBe(3);
    expect(out.status).toBe("failed");
    expect(out.errorCode).toBe("rate_limited");
  });

  it("never lets one cell's failure escape the chunk", async () => {
    const d = deps();
    const a = adapter({
      run: async (input) => {
        if ((input as { domain: string }).domain === "boom.com") throw new Error("kaboom");
        return { ok: true };
      },
    });

    const outs = await processChunk(
      [work("r1"), work("r2", { domain: "boom.com" }), work("r3")],
      a,
      d,
    );

    expect(outs.map((o) => o.status)).toEqual(["done", "failed", "done"]);
  });

  it("records credits and the api_call_id in provenance", async () => {
    const d = deps();
    const a = adapter({
      run: async (_input, ctx) => {
        const r = await ctx.fiber.call(KITCHEN_SINK, "post", {});
        return { name: r.data.output.data[0]?.preferred_name ?? null };
      },
    });

    const [out] = await processChunk([work("r1")], a, d);

    expect(out.provenance.cache_hit).toBe(false);
    expect(out.provenance.credits).toBe(2);
    expect(out.provenance.api_call_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("respects the adapter's concurrency limit", async () => {
    const d = deps();
    let inFlight = 0;
    let peak = 0;
    const a = adapter({
      concurrency: 2,
      run: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { ok: true };
      },
    });

    await processChunk([work("r1"), work("r2"), work("r3"), work("r4")], a, d);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

/* ------------------------------------------------------------------ */
/* batch mode                                                          */
/* ------------------------------------------------------------------ */

describe("processBatchChunk (batch)", () => {
  const batchAdapter = (results: Array<unknown>) =>
    adapter({
      id: "fiber.test.batch",
      mode: "batch",
      run: undefined,
      runBatch: async () => results,
    });

  it("maps positional results onto cells, including a mid-array AdapterError", async () => {
    const err: AdapterError = { code: "no_match", message: "not found", retryable: false };
    const a = batchAdapter([{ v: 1 }, err, { v: 3 }]);

    const outs = await processBatchChunk(
      [work("r1", { a: 1 }), work("r2", { a: 2 }), work("r3", { a: 3 })],
      a,
      deps(),
    );

    expect(outs.map((o) => o.status)).toEqual(["done", "failed", "done"]);
    expect(outs[0].value).toEqual({ v: 1 });
    expect(outs[1].errorCode).toBe("no_match");
    expect(outs[2].value).toEqual({ v: 3 });
    // Order is preserved, so a cell never receives another cell's result.
    expect(outs.map((o) => o.rowId)).toEqual(["r1", "r2", "r3"]);
  });

  it("treats a null entry as a successful empty result", async () => {
    const outs = await processBatchChunk([work("r1", { a: 1 })], batchAdapter([null]), deps());
    expect(outs[0].status).toBe("done");
    expect(outs[0].value).toBeNull();
  });

  it("fails every cell when the whole batch call throws", async () => {
    const a = adapter({
      mode: "batch",
      run: undefined,
      runBatch: async () => {
        throw new FiberError({ status: 500, code: "server_error", retryable: true, message: "down" });
      },
    });

    const outs = await processBatchChunk([work("r1", { a: 1 }), work("r2", { a: 2 })], a, deps());
    expect(outs.every((o) => o.status === "failed" && o.errorCode === "server_error")).toBe(true);
  });

  it("fails cells the adapter returned no result for", async () => {
    const outs = await processBatchChunk(
      [work("r1", { a: 1 }), work("r2", { a: 2 })],
      batchAdapter([{ v: 1 }]),
      deps(),
    );
    expect(outs[1].status).toBe("failed");
    expect(outs[1].errorCode).toBe("batch_result_missing");
  });

  it("writes whole credits to the cache, which is an integer column", async () => {
    const d = deps();
    const written: number[] = [];
    const originalSet = d.cache.set.bind(d.cache);
    d.cache.set = async (key, value, credits, ttl) => {
      written.push(credits);
      return originalSet(key, value, credits, ttl);
    };

    // One charged credit spread across five cells is 0.2 each.
    const a = adapter({
      mode: "batch",
      run: undefined,
      runBatch: async (inputs, ctx) => {
        await ctx.fiber.call("/v1/kitchen-sink/company", "post", {});
        return inputs.map(() => ({ ok: true }));
      },
    });

    await processBatchChunk(
      [1, 2, 3, 4, 5].map((n) => work(`r${n}`, { a: n })),
      a,
      d,
    );

    expect(written.length).toBe(5);
    for (const credits of written) {
      expect(Number.isInteger(credits), `wrote ${credits} to an integer column`).toBe(true);
    }
  });

  it("serves cached cells without including them in the batch call", async () => {
    const d = deps();
    let batched = 0;
    const a = adapter({
      mode: "batch",
      run: undefined,
      runBatch: async (inputs) => {
        batched = inputs.length;
        return inputs.map(() => ({ fresh: true }));
      },
    });
    await d.cache.set(a.cacheKey({ a: 1 }), { cached: true }, 0, 60);

    const outs = await processBatchChunk([work("r1", { a: 1 }), work("r2", { a: 2 })], a, d);

    expect(batched).toBe(1);
    expect(outs[0].provenance.cache_hit).toBe(true);
    expect(outs[1].value).toEqual({ fresh: true });
  });
});

/* ------------------------------------------------------------------ */
/* async mode                                                          */
/* ------------------------------------------------------------------ */

describe("processAsyncCell (async)", () => {
  const asyncAdapter = (states: PollResult<unknown>[]) => {
    let i = 0;
    return adapter({
      id: "fiber.test.async",
      mode: "async",
      run: undefined,
      start: async () => ({ handle: "job-1" }),
      poll: async () => states[Math.min(i++, states.length - 1)],
    });
  };

  it("reaches done after pending, pending, done", async () => {
    const a = asyncAdapter([
      { state: "pending" },
      { state: "pending" },
      { state: "done", value: { handles: "@acme" } },
    ]);

    const out = await processAsyncCell(work("r1"), a, deps());

    expect(out.status).toBe("done");
    expect(out.value).toEqual({ handles: "@acme" });
  });

  it("times out with poll_timeout after the poll budget", async () => {
    const a = asyncAdapter([{ state: "pending" }]);
    const out = await processAsyncCell(work("r1"), a, deps());

    expect(out.status).toBe("failed");
    expect(out.errorCode).toBe("poll_timeout");
    expect(out.errorMessage).toContain(String(MAX_POLLS));
  });

  it("polls exactly the budgeted number of times before giving up", async () => {
    let polls = 0;
    const a = adapter({
      mode: "async",
      run: undefined,
      start: async () => ({ handle: "h" }),
      poll: async () => {
        polls += 1;
        return { state: "pending" } as PollResult<unknown>;
      },
    });

    await processAsyncCell(work("r1"), a, deps());
    expect(polls).toBe(MAX_POLLS);
  });

  it("fails the cell when the adapter reports a failed poll", async () => {
    const a = asyncAdapter([
      { state: "failed", error: { code: "no_match", message: "nothing", retryable: false } },
    ]);
    const out = await processAsyncCell(work("r1"), a, deps());

    expect(out.status).toBe("failed");
    expect(out.errorCode).toBe("no_match");
  });

  it("fails the cell when start() throws", async () => {
    const a = adapter({
      mode: "async",
      run: undefined,
      start: async () => {
        throw new FiberError({ status: 400, code: "bad_request", retryable: false, message: "no" });
      },
      poll: async () => ({ state: "pending" }) as PollResult<unknown>,
    });

    const out = await processAsyncCell(work("r1"), a, deps());
    expect(out.status).toBe("failed");
    expect(out.errorCode).toBe("bad_request");
  });

  it("serves a cache hit without starting a job", async () => {
    const d = deps();
    let started = false;
    const a = adapter({
      mode: "async",
      run: undefined,
      start: async () => {
        started = true;
        return { handle: "h" };
      },
      poll: async () => ({ state: "pending" }) as PollResult<unknown>,
    });
    await d.cache.set(a.cacheKey({ domain: "acme.com" }), { cached: true }, 0, 60);

    const out = await processAsyncCell(work("r1"), a, d);
    expect(started).toBe(false);
    expect(out.provenance.cache_hit).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Helpers and finalisation                                            */
/* ------------------------------------------------------------------ */

describe("toAdapterError", () => {
  it("keeps a FiberError's retryability", () => {
    const e = toAdapterError(
      new FiberError({ status: 429, code: "rate_limited", retryable: true, message: "slow" }),
    );
    expect(e).toEqual({ code: "rate_limited", message: "slow", retryable: true });
  });

  it("treats an unknown error as terminal", () => {
    expect(toAdapterError(new Error("boom")).retryable).toBe(false);
    expect(toAdapterError("weird").retryable).toBe(false);
  });

  it("passes an AdapterError shape through unchanged", () => {
    const err: AdapterError = { code: "x", message: "y", retryable: true };
    expect(toAdapterError(err)).toEqual(err);
  });
});

describe("chunking and concurrency helpers", () => {
  it("chunks to the requested size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 10)).toEqual([]);
  });

  it("preserves order under bounded concurrency", async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 2);
    expect(out).toEqual([2, 4, 6, 8, 10]);
  });
});

describe("countCells", () => {
  it("counts each terminal state and cache hits", () => {
    expect(
      countCells([
        { status: "done", provenance: { cache_hit: true } },
        { status: "done", provenance: { cache_hit: false } },
        { status: "failed", provenance: null },
        { status: "skipped", provenance: null },
        { status: "pending", provenance: null },
      ]),
    ).toEqual({ total: 5, done: 2, failed: 1, skipped: 1, cache_hits: 1 });
  });
});

/* ------------------------------------------------------------------ */
/* Dotted source references                                            */
/* ------------------------------------------------------------------ */

describe("parseSourceRef", () => {
  it("treats a bare id as a whole-cell reference", () => {
    expect(parseSourceRef("col-1")).toEqual({ columnId: "col-1", field: null });
  });

  it("splits on the first dot, so field keys may contain dots", () => {
    expect(parseSourceRef("col-1.linkedin_url")).toEqual({
      columnId: "col-1",
      field: "linkedin_url",
    });
    expect(parseSourceRef("col-1.a.b")).toEqual({ columnId: "col-1", field: "a.b" });
  });
});

describe("readSourceValue", () => {
  const done = (value: unknown) => cell({ value });

  it("returns the whole value when no field is named", () => {
    expect(readSourceValue(done("acme.com"), null)).toEqual({ ok: true, value: "acme.com" });
  });

  it("returns the named field", () => {
    expect(readSourceValue(done({ a: 1 }), "a")).toEqual({ ok: true, value: 1 });
  });

  it("rejects an empty string field, which is as useless as null", () => {
    expect(readSourceValue(done({ a: "" }), "a")).toEqual({
      ok: false,
      reason: 'source field "a" is empty',
    });
  });

  it("rejects an array source for a field read", () => {
    expect(readSourceValue(done([1, 2]), "a").ok).toBe(false);
  });
});
