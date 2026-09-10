/**
 * Step 0 gate probe for the automated row sources feature.
 *
 * Sends one minimal but VALID request to every Saved Search and Tracker
 * operation the feature would need, and reports what a sandbox key can
 * actually reach. Body validation runs before the sandbox check, so an
 * incomplete body returns 400 and hides a 501 — every body here is built from
 * the required fields in src/fiber/types.generated.d.ts and the per-operation
 * docs at https://api.fiber.ai/ai-docs/<operationId>.md.
 *
 * Diagnostic only. It writes no feature code and touches no database.
 *
 *   pnpm tsx scripts/probe-sources.ts
 *
 * Costs: createSavedSearch and manuallySpawnSavedSearchRun are 2 credits per
 * result found (capped here with maxNewCompaniesPerRun: 1), and
 * refreshTrackerPersonList charges per tracked entity (one seed person). The
 * run total is printed at the end from chargeInfo.
 */
import { FiberHttpClient, MemoryApiCallLogger } from "@/fiber/client";
import { FiberError } from "@/fiber/errors";

process.loadEnvFile(".env.local");

const API_KEY = process.env.FIBER_API_KEY ?? "";
if (!API_KEY) {
  console.error("FIBER_API_KEY is not set in .env.local");
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Plumbing                                                            */
/* ------------------------------------------------------------------ */

/**
 * FiberError carries a classified code and message but not the raw payload,
 * and the probe is meant to show the payload. Teeing the response here is the
 * only way to see it without bypassing the client.
 */
let lastStatus: number | null = null;
let lastBody = "";

const fetchImpl: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  lastStatus = response.status;
  lastBody = await response.clone().text();
  return response;
};

const logger = new MemoryApiCallLogger();
const client = new FiberHttpClient({ apiKey: API_KEY, logger, fetchImpl });

/**
 * The probe walks operations by URL, including path-templated ones like
 * /v1/tracker/signals/{listId}, so the generic path/method pair the typed
 * surface expects is erased here. Calls still go through FiberHttpClient, which
 * is what the client rule in CLAUDE.md is about.
 */
type LooseFiberClient = {
  call(path: string, method: string, body: unknown): Promise<{ data: unknown; credits: number }>;
};
const loose = client as unknown as LooseFiberClient;

type Probe = {
  op: string;
  status: number | null;
  body: string;
  note: string;
};

const results: Probe[] = [];
let creditsSpent = 0;

async function probe(
  op: string,
  method: "get" | "post" | "put" | "delete",
  url: string,
  body: Record<string, unknown> = {},
): Promise<unknown> {
  lastStatus = null;
  lastBody = "";

  let data: unknown = null;
  let note = "";

  try {
    const result = await loose.call(url, method, body);
    data = result.data;
    creditsSpent += result.credits;
    if (result.credits) note = `charged ${result.credits} credits`;
  } catch (e) {
    if (e instanceof FiberError) {
      note = `${e.code}${e.retryable ? " (retryable)" : ""}`;
    } else {
      note = e instanceof Error ? e.message : String(e);
    }
  }

  const status = lastStatus;
  const snippet = lastBody.replace(/\s+/g, " ").slice(0, 200);
  results.push({ op, status, body: snippet, note });

  console.log(`${op}\n  ${method.toUpperCase()} ${url}\n  status: ${status ?? "no response"}\n  body:   ${snippet || "(empty)"}\n`);

  return data;
}

/** Reads output.<key> off a Fiber envelope, or null when the call failed. */
function outputId(data: unknown, key = "id"): string | null {
  if (!data || typeof data !== "object") return null;
  const output = (data as { output?: unknown }).output;
  if (!output || typeof output !== "object") return null;
  const value = (output as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/**
 * Dependent operations run even when their create failed, using a placeholder.
 * That is the point: against a live endpoint a bad id returns 404, against a
 * sandbox-blocked one it still returns 501, so every row gets a real verdict.
 */
const PLACEHOLDER = "probe-placeholder-id";
const stamp = new Date().toISOString().slice(0, 16);

/* ------------------------------------------------------------------ */
/* Saved search                                                        */
/* ------------------------------------------------------------------ */

async function probeSavedSearch(): Promise<void> {
  console.log("── Saved search ──────────────────────────────────────────\n");

  await probe("listSavedSearch", "post", "/v1/saved-search/list", { pageSize: 5 });

  // type "companies" is the narrowest of the three searchParams variants, and
  // one exact domain keeps the per-result charge to a single company.
  const created = await probe("createSavedSearch", "post", "/v1/saved-search/create", {
    name: `OpenCeramic probe ${stamp}`,
    searchParams: {
      type: "companies",
      companySearchParams: { domains: ["stripe.com"] },
      maxNewCompaniesPerRun: 1,
    },
    // Required, and absent from both the generated types' searchParams block
    // and the ai-docs schema (truncated at 64KB). Omitting it returns a 400
    // that hides whatever the sandbox check would have said.
    spawnFrequencyDays: 7,
  });
  const savedSearchId = outputId(created) ?? PLACEHOLDER;

  const spawned = await probe("manuallySpawnSavedSearchRun", "post", "/v1/saved-search/spawn", {
    savedSearchId,
  });

  const latest = await probe("getLatestSavedSearchRun", "post", "/v1/saved-search/run/get-latest", {
    savedSearchId,
  });

  // getLatest nests the run; spawn returns it flat.
  const latestRunId =
    (latest && typeof latest === "object"
      ? (((latest as { output?: { run?: { id?: unknown } } }).output?.run?.id as string) ?? null)
      : null) ?? outputId(spawned);
  const savedSearchRunId = latestRunId ?? PLACEHOLDER;

  await probe("getSavedSearchRunStatus", "post", "/v1/saved-search/run/status", {
    savedSearchRunId,
  });
  await probe("getSavedSearchRunProfiles", "post", "/v1/saved-search/run/profiles", {
    savedSearchRunId,
    pageSize: 5,
  });
  await probe("getSavedSearchRunCompanies", "post", "/v1/saved-search/run/companies", {
    savedSearchRunId,
    pageSize: 5,
  });
}

/* ------------------------------------------------------------------ */
/* Tracker                                                             */
/* ------------------------------------------------------------------ */

async function probeTracker(): Promise<void> {
  console.log("── Tracker ───────────────────────────────────────────────\n");

  await probe("listAvailableTrackerRules", "get", "/v1/tracker/rules");
  await probe("getTrackerOverview", "get", "/v1/tracker/overview");

  // isDummy rules are skipped by scheduled runs and only fire via fire-dummy,
  // so creating these lists starts no real monitoring.
  const companyList = await probe(
    "createTrackerCompanyList",
    "post",
    "/v1/tracker/company-lists",
    {
      name: `OpenCeramic probe companies ${stamp}`,
      refreshIntervalDays: 30,
      trackingRules: [{ type: "new_funding_round", entityType: "company", isDummy: true }],
    },
  );
  const companyListId = outputId(companyList) ?? PLACEHOLDER;

  const personList = await probe("createTrackerPersonList", "post", "/v1/tracker/person-lists", {
    name: `OpenCeramic probe people ${stamp}`,
    refreshIntervalDays: 30,
    trackingRules: [{ type: "person_changed_company", entityType: "person", isDummy: true }],
  });
  const personListId = outputId(personList) ?? PLACEHOLDER;

  await probe(
    "addTrackerCompanies",
    "put",
    `/v1/tracker/company-lists/${companyListId}/companies`,
    { companies: [{ domain: "stripe.com" }] },
  );

  await probe("addTrackerPeople", "put", `/v1/tracker/person-lists/${personListId}/people`, {
    people: [{ linkedinSlug: "williamhgates" }],
  });

  await probe("listTrackerSignals", "get", `/v1/tracker/signals/${companyListId}`, {
    filter: "dummy",
    pageSize: 10,
  });

  await probe("previewTrackerSignal", "post", "/v1/tracker/rules/preview-signal", {
    config: { type: "new_funding_round", entityType: "company", isDummy: true },
  });

  // fireTrackerDummy is a POST that documents apiKey as a QUERY parameter,
  // unlike every other POST in the API. The client puts the key in the body for
  // non-GET methods, so the key is pinned to the URL here as well. If this row
  // comes back 200 while others 501, client.ts needs query-auth support for
  // POST before the tracker source can use it.
  await probe(
    "fireTrackerDummy",
    "post",
    `/v1/tracker/fire-dummy/${companyListId}?apiKey=${encodeURIComponent(API_KEY)}`,
  );

  // Charges per tracked entity; the person list has at most the one seed above.
  await probe(
    "refreshTrackerPersonList",
    "post",
    `/v1/tracker/person-lists/${personListId}/refresh`,
  );
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

function reachability(status: number | null): string {
  if (status === null) return "unknown";
  if (status >= 200 && status < 300) return "yes";
  if (status === 501) return "no — sandbox 501";
  if (status === 401 || status === 402) return "blocked — key/credits";
  if (status === 400 || status === 404 || status === 409 || status === 422) {
    return "yes — request rejected";
  }
  if (status === 429) return "yes — rate limited";
  return "unknown";
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function report(): void {
  console.log("\n## Probe results\n");
  console.log("| operation | status | reachable? | note |");
  console.log("| --- | --- | --- | --- |");
  for (const r of results) {
    const note = r.note ? `${r.note} — ${r.body}` : r.body;
    console.log(
      `| \`${r.op}\` | ${r.status ?? "—"} | ${reachability(r.status)} | ${cell(note.slice(0, 160)) || "—"} |`,
    );
  }

  const reachable = results.filter((r) => reachability(r.status) === "yes").length;
  console.log(`\n${reachable} of ${results.length} operations returned 2xx.`);
  console.log(`Credits charged during this probe: ${creditsSpent}.`);
  console.log(`API calls logged: ${logger.entries.length}.`);
}

async function main(): Promise<void> {
  console.log(`Probing ${process.env.FIBER_BASE_URL ?? "https://api.fiber.ai"} with key ${API_KEY.slice(0, 7)}…\n`);
  await probeSavedSearch();
  await probeTracker();
  report();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
