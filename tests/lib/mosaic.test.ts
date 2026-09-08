import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchHealedRows, pickImportColumns, pollMosaic, startMosaic } from "@/lib/mosaic";
import { FakeFiberClient } from "@/fiber/fake";
import { FiberError } from "@/fiber/errors";

const SHEET = "https://docs.google.com/spreadsheets/d/abc/edit";

afterEach(() => vi.unstubAllGlobals());

describe("startMosaic", () => {
  it("returns the run id and whether it is a free trial run", async () => {
    const fiber = new FakeFiberClient({ inMemory: true });
    await expect(startMosaic(fiber, SHEET)).resolves.toEqual({
      runId: "mosaic_01HZY8QK3M4N5P6R7S8T9UVWXY",
      isFreeTrialRun: true,
    });
  });

  it("sends the source URL Fiber will fetch, not a file", async () => {
    const fiber = new FakeFiberClient({ inMemory: true });
    await startMosaic(fiber, SHEET, { customInstructions: "treat col A as domain", maxRows: 500 });
    expect(fiber.memoryLog.entries[0].endpoint).toBe("/v1/mosaic/start");
  });

  it("propagates a terminal Fiber error rather than swallowing it", async () => {
    const fiber = new FakeFiberClient({ inMemory: true });
    fiber.program("/v1/mosaic/start", { kind: "terminal", status: 400, code: "bad_source_url" });
    await expect(startMosaic(fiber, "https://nope.invalid/x.csv")).rejects.toBeInstanceOf(FiberError);
  });
});

describe("pollMosaic", () => {
  it("reports a finished run with its stats and download link", async () => {
    const fiber = new FakeFiberClient({ inMemory: true });
    const run = await pollMosaic(fiber, "mosaic_1");

    expect(run.status).toBe("done");
    expect(run.stats).toMatchObject({ inputRows: 4, outputRows: 4, rowsWithErrors: 1 });
    expect(run.outputCsvUrl).toContain(".csv");
  });

  it("reports progress while still running, with no CSV yet", async () => {
    const fiber = new FakeFiberClient({ inMemory: true });
    fiber.program("/v1/mosaic/poll", { kind: "fixture", key: "running" });

    const run = await pollMosaic(fiber, "mosaic_1");
    expect(run.status).toBe("running");
    expect(run.processedRowCount).toBe(2);
    expect(run.outputCsvUrl).toBeNull();
  });

  it("surfaces a failed run", async () => {
    const fiber = new FakeFiberClient({ inMemory: true });
    fiber.program("/v1/mosaic/poll", { kind: "not_found" });

    const run = await pollMosaic(fiber, "mosaic_1");
    expect(run.status).toBe("failed");
    expect(run.outputCsvUrl).toBeNull();
  });
});

describe("fetchHealedRows", () => {
  const csv = [
    "Company,Website,Contact",
    "Stripe,stripe.com,patrick@stripe.com",
    "Linear,linear.app,",
    ",,",
    "Vercel,vercel.com,guillermo@vercel.com",
  ].join("\n");

  it("parses the healed CSV and drops blank rows", async () => {
    vi.stubGlobal("fetch", async () => new Response(csv, { status: 200 }));

    const { headers, rows } = await fetchHealedRows("https://files.fiber.ai/x.csv");
    expect(headers).toEqual(["Company", "Website", "Contact"]);
    expect(rows).toHaveLength(3); // the all-empty row is dropped
    expect(rows[0]).toEqual({ Company: "Stripe", Website: "stripe.com", Contact: "patrick@stripe.com" });
  });

  it("keeps a row that is only partly filled — that is the point of healing", async () => {
    vi.stubGlobal("fetch", async () => new Response(csv, { status: 200 }));
    const { rows } = await fetchHealedRows("https://files.fiber.ai/x.csv");
    expect(rows[1]).toEqual({ Company: "Linear", Website: "linear.app", Contact: "" });
  });

  it("respects the row limit", async () => {
    vi.stubGlobal("fetch", async () => new Response(csv, { status: 200 }));
    const { rows } = await fetchHealedRows("https://files.fiber.ai/x.csv", 2);
    expect(rows).toHaveLength(2);
  });

  it("throws when the temporary download link has expired", async () => {
    vi.stubGlobal("fetch", async () => new Response("gone", { status: 403 }));
    await expect(fetchHealedRows("https://files.fiber.ai/x.csv")).rejects.toThrow("403");
  });
});

describe("pickImportColumns", () => {
  it("caps the width, since Mosaic emits wide files", () => {
    const many = Array.from({ length: 40 }, (_, i) => `col${i}`);
    expect(pickImportColumns(many)).toHaveLength(12);
  });

  it("drops blank headers", () => {
    expect(pickImportColumns(["A", "  ", "B"])).toEqual(["A", "B"]);
  });
});
