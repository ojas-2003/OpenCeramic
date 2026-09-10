import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildConfig } from "@/lib/sourceConfig";
import type { RowSourceRecord } from "@/db/schema";
import type { SourceMeta } from "@/lib/types";

/**
 * The source routes, with the database mocked and Fiber served from fixtures —
 * getFiberClient() returns FakeFiberClient under NODE_ENV=test, so setup()
 * exercises the real adapter against the real fixtures.
 */

const createSource = vi.fn();
const getSource = vi.fn();
const getTable = vi.fn();
const updateSource = vi.fn();
const deleteSource = vi.fn();
const listSourcesForTable = vi.fn();
const send = vi.fn();

vi.mock("@/db/queries", () => ({
  createSource: (...a: unknown[]) => createSource(...a),
  getSource: (...a: unknown[]) => getSource(...a),
  getTable: (...a: unknown[]) => getTable(...a),
  updateSource: (...a: unknown[]) => updateSource(...a),
  deleteSource: (...a: unknown[]) => deleteSource(...a),
  listSourcesForTable: (...a: unknown[]) => listSourcesForTable(...a),
}));

vi.mock("@/inngest/client", () => ({ inngest: { send: (...a: unknown[]) => send(...a) } }));

const { POST: addSource } = await import("@/app/api/tables/[id]/sources/route");
const { PATCH: patchSource, DELETE: removeSource } = await import("@/app/api/sources/[id]/route");
const { POST: pollNow } = await import("@/app/api/sources/[id]/poll/route");
const { POST: testSignal } = await import("@/app/api/sources/[id]/test-signal/route");
const { GET: listSources } = await import("@/app/api/sources/route");
const { GET: registry } = await import("@/app/api/sources/registry/route");

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const post = (body: unknown) =>
  new Request("http://test/api", { method: "POST", body: JSON.stringify(body) });

const TRACKER: RowSourceRecord = {
  id: "src_1",
  tableId: "tbl_1",
  kind: "tracker",
  name: "Funding watch",
  config: { listId: "trk_openceramic", entity: "company", ruleIds: ["new_funding_round"] },
  cursor: {},
  status: "active",
  autoEnrich: true,
  errorMessage: null,
  lastPolledAt: null,
  createdAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  getTable.mockResolvedValue({ id: "tbl_1", name: "Demo", entityType: "company" });
  createSource.mockImplementation(async (v: unknown) => ({ ...TRACKER, ...(v as object) }));
  updateSource.mockImplementation(async (_id, patch) => ({ ...TRACKER, ...patch }));
});

describe("POST /api/tables/:id/sources", () => {
  it("creates the Fiber-side list and stores the id it returns", async () => {
    const response = await addSource(
      post({
        source_id: "fiber.source.tracker",
        name: "Funding watch",
        config: { entity: "company", ruleIds: ["new_funding_round"], seedIdentifiers: ["stripe.com"] },
        auto_enrich: true,
      }),
      params("tbl_1"),
    );

    expect(response.status).toBe(201);
    const stored = createSource.mock.calls[0][0] as { kind: string; config: { listId?: string } };
    // setup() ran and its listId was merged in — without it the source could
    // never be polled, because poll() has nothing to address.
    expect(stored.config.listId).toBe("trk_openceramic");
    expect(stored.kind).toBe("tracker");
  });

  it("rejects a source that is not registered", async () => {
    const response = await addSource(
      post({ source_id: "fiber.source.nope", name: "x", config: {} }),
      params("tbl_1"),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("unknown_source");
    expect(createSource).not.toHaveBeenCalled();
  });

  it("validates the config with the source's own schema before calling Fiber", async () => {
    const response = await addSource(
      // ruleIds must be an array of strings; entity must be person or company.
      post({ source_id: "fiber.source.tracker", name: "x", config: { entity: "aliens" } }),
      params("tbl_1"),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_config");
    expect(createSource).not.toHaveBeenCalled();
  });

  it("404s for a table that does not exist", async () => {
    getTable.mockResolvedValue(null);
    const response = await addSource(
      post({ source_id: "fiber.source.tracker", name: "x", config: { entity: "company", ruleIds: [] } }),
      params("tbl_missing"),
    );
    expect(response.status).toBe(404);
  });

  it("defaults auto_enrich on", async () => {
    await addSource(
      post({
        source_id: "fiber.source.tracker",
        name: "x",
        config: { entity: "company", ruleIds: [] },
      }),
      params("tbl_1"),
    );
    expect((createSource.mock.calls[0][0] as { autoEnrich: boolean }).autoEnrich).toBe(true);
  });
});

describe("PATCH /api/sources/:id", () => {
  it("clears the message when a paused source is resumed", async () => {
    getSource.mockResolvedValue({ ...TRACKER, status: "paused", errorMessage: "over budget" });

    await patchSource(post({ status: "active" }), params("src_1"));

    // Leaving the banner behind would tell the user it is still paused.
    expect(updateSource).toHaveBeenCalledWith("src_1", {
      status: "active",
      errorMessage: null,
    });
  });

  it("toggles auto-enrich without touching status", async () => {
    getSource.mockResolvedValue(TRACKER);
    await patchSource(post({ auto_enrich: false }), params("src_1"));
    expect(updateSource).toHaveBeenCalledWith("src_1", { autoEnrich: false });
  });

  it("404s for an unknown source", async () => {
    getSource.mockResolvedValue(null);
    const response = await patchSource(post({ name: "x" }), params("nope"));
    expect(response.status).toBe(404);
  });
});

describe("DELETE /api/sources/:id", () => {
  it("reports 404 when there was nothing to delete", async () => {
    deleteSource.mockResolvedValue(false);
    expect((await removeSource(post({}), params("nope"))).status).toBe(404);
  });

  it("deletes an existing source", async () => {
    deleteSource.mockResolvedValue(true);
    const response = await removeSource(post({}), params("src_1"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
  });
});

describe("POST /api/sources/:id/poll", () => {
  it("asks the poller for this one source and returns straight away", async () => {
    getSource.mockResolvedValue(TRACKER);

    const response = await pollNow(post({}), params("src_1"));

    expect(response.status).toBe(202);
    expect(send).toHaveBeenCalledWith({
      name: "sources/poll.requested",
      data: { sourceId: "src_1" },
    });
  });
});

describe("POST /api/sources/:id/test-signal", () => {
  it("fires a dummy signal and asks the poller to pick it up", async () => {
    getSource.mockResolvedValue(TRACKER);

    const response = await testSignal(post({}), params("src_1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ fired: 1 });
    // Firing only persists the signal on Fiber's side; the poll is what makes
    // a row appear, which is the whole point of the button.
    expect(send).toHaveBeenCalledWith({
      name: "sources/poll.requested",
      data: { sourceId: "src_1" },
    });
  });

  it("refuses with a clear message for a saved search", async () => {
    getSource.mockResolvedValue({ ...TRACKER, kind: "saved_search" });

    const response = await testSignal(post({}), params("src_1"));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("not_a_tracker");
    expect(body.error.message).toContain("Poll now");
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses when the tracker has no Fiber list yet", async () => {
    getSource.mockResolvedValue({ ...TRACKER, config: { entity: "company", ruleIds: [] } });

    const response = await testSignal(post({}), params("src_1"));

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("not_set_up");
  });
});

describe("GET /api/sources", () => {
  it("requires a table_id", async () => {
    const response = await listSources(new Request("http://test/api/sources"));
    expect(response.status).toBe(400);
  });

  it("returns the sources on a table", async () => {
    listSourcesForTable.mockResolvedValue([{ ...TRACKER, rowCount: 3 }]);
    const response = await listSources(new Request("http://test/api/sources?table_id=tbl_1"));
    expect((await response.json()).sources[0].rowCount).toBe(3);
  });
});

describe("GET /api/sources/registry", () => {
  it("offers both sources with the fields the dialog needs", async () => {
    const { sources } = (await (await registry()).json()) as { sources: SourceMeta[] };

    expect(sources.map((s) => s.id).sort()).toEqual([
      "fiber.source.savedSearch",
      "fiber.source.tracker",
    ]);
    for (const source of sources) {
      expect(source.configFields.length).toBeGreaterThan(0);
      expect(source.supportsSetup).toBe(true);
    }
  });
});

describe("buildConfig", () => {
  const tracker: SourceMeta = {
    id: "fiber.source.tracker",
    kind: "tracker",
    label: "Tracker",
    description: "",
    entity: "company",
    supportsSetup: true,
    configFields: [
      { key: "entity", label: "Track", type: "string" },
      { key: "ruleIds", label: "Rules", type: "json" },
      { key: "seedIdentifiers", label: "Seed with", type: "json" },
      { key: "listId", label: "Existing list id", type: "string" },
    ],
  };

  it("splits a comma-separated list into an array", () => {
    expect(
      buildConfig(tracker, {
        entity: "company",
        ruleIds: "new_funding_round, funding_stage_changed",
        seedIdentifiers: " stripe.com ,linear.app ",
      }),
    ).toEqual({
      entity: "company",
      ruleIds: ["new_funding_round", "funding_stage_changed"],
      seedIdentifiers: ["stripe.com", "linear.app"],
    });
  });

  it("omits blank fields rather than sending empty strings", () => {
    const config = buildConfig(tracker, { entity: "company", listId: "  " });
    expect(config).not.toHaveProperty("listId");
  });

  it("always supplies ruleIds, which the tracker schema requires", () => {
    expect(buildConfig(tracker, { entity: "company" }).ruleIds).toEqual([]);
  });

  it("takes a literal object for searchParams rather than splitting it", () => {
    const savedSearch: SourceMeta = {
      ...tracker,
      kind: "saved_search",
      configFields: [{ key: "searchParams", label: "Search parameters", type: "json" }],
    };

    // searchParams is an object, not a list. Comma-splitting it would produce
    // an array the source's schema rejects, so the dialog could never create
    // a saved search at all.
    expect(buildConfig(savedSearch, { searchParams: '{"domains": ["stripe.com", "linear.app"]}' })).toEqual({
      searchParams: { domains: ["stripe.com", "linear.app"] },
    });
  });

  it("passes malformed JSON through so the error names the value", () => {
    const savedSearch: SourceMeta = {
      ...tracker,
      kind: "saved_search",
      configFields: [{ key: "searchParams", label: "Search parameters", type: "json" }],
    };
    expect(buildConfig(savedSearch, { searchParams: "{oops" })).toEqual({ searchParams: "{oops" });
  });

  it("coerces a number field", () => {
    const savedSearch: SourceMeta = {
      ...tracker,
      kind: "saved_search",
      configFields: [{ key: "spawnFrequencyDays", label: "Every", type: "number" }],
    };
    expect(buildConfig(savedSearch, { spawnFrequencyDays: "14" })).toEqual({
      spawnFrequencyDays: 14,
    });
  });
});
