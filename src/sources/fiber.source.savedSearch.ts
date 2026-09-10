import { z } from "zod";

import { normalizeDomain, normalizeUrl } from "@/enrichments/normalize";
import type { Ctx } from "@/enrichments/types";
import type { DiscoveredRow, PollResult, RowSource } from "@/sources/types";

const config = z.object({
  /** Absent until setup() creates the search on Fiber's side. */
  savedSearchId: z.string().min(1).optional(),
  /** Passed straight to createSavedSearch; see the createSavedSearch ai-docs. */
  searchParams: z.record(z.string(), z.unknown()).optional(),
  entity: z.enum(["person", "company"]),
  /** How often Fiber re-runs the search itself. Required by createSavedSearch. */
  spawnFrequencyDays: z.number().int().positive().default(7),
});

type Config = z.infer<typeof config>;

/** One page is the API maximum; ten of them bounds a single poll at 1000 rows. */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/**
 * A saved search that Fiber re-runs on its own schedule. Each run reports which
 * entities joined, returned, departed or stayed; this source turns the arrivals
 * into rows.
 *
 * The cursor is the id of the last run whose results were imported. It moves
 * only when a run has been read to completion — a run that is still building
 * leaves it alone, so the next poll picks the same run up again rather than
 * skipping past everything it contained.
 */
export const fiberSourceSavedSearch: RowSource<Config> = {
  kind: "saved_search",
  id: "fiber.source.savedSearch",
  label: "Saved search",
  description:
    "Fiber re-runs a search on a schedule; whoever newly matches it becomes a row.",
  // Both entities are supported — config.entity picks which. See the note in
  // src/sources/types.ts: the interface has no "any", so this is the default.
  entity: "company",
  config,
  configFields: [
    { key: "entity", label: "Find", type: "string" },
    { key: "savedSearchId", label: "Existing saved search id", type: "string" },
    { key: "searchParams", label: "Search parameters", type: "json" },
    { key: "spawnFrequencyDays", label: "Fiber re-runs every (days)", type: "number" },
  ],

  identityFor(item: unknown): string | null {
    const entry = item as { profile?: ProfileLike; company?: CompanyLike } | null;
    if (entry?.profile) return profileIdentity(entry.profile);
    if (entry?.company) return companyIdentity(entry.company);
    return null;
  },

  /**
   * Creates the search on Fiber and hands back its id, which the API route
   * merges into the stored config. A config that already carries an id is
   * left alone, so attaching an existing search costs nothing.
   */
  async setup(cfg: Config, ctx: Ctx): Promise<Partial<Config>> {
    if (cfg.savedSearchId) return {};

    const created = await ctx.fiber.call("/v1/saved-search/create", "post", {
      name: `OpenCeramic ${cfg.entity} search`,
      // The union is discriminated on `type`; the caller supplies the filters.
      searchParams: (cfg.entity === "person"
        ? { type: "profiles", profileSearchParams: cfg.searchParams ?? {} }
        : {
            type: "companies",
            companySearchParams: cfg.searchParams ?? {},
          }) as never,
      spawnFrequencyDays: cfg.spawnFrequencyDays,
    });

    return { savedSearchId: created.data.output.id };
  },

  async poll(cfg: Config, cursor: Record<string, unknown>, ctx: Ctx): Promise<PollResult> {
    if (!cfg.savedSearchId) {
      return { rows: [], cursor, note: "no saved search yet — run setup first" };
    }

    const latest = await ctx.fiber.call("/v1/saved-search/run/get-latest", "post", {
      savedSearchId: cfg.savedSearchId,
    });
    const run = latest.data.output?.run;
    if (!run) return { rows: [], cursor, note: "no runs yet" };

    // Already imported. Nothing to do and nothing to move.
    if (run.id === cursor.last_run_id) return { rows: [], cursor };

    const status = await ctx.fiber.call("/v1/saved-search/run/status", "post", {
      savedSearchRunId: run.id,
    });
    const state = status.data.output.run.status;

    if (state === "NOT_STARTED" || state === "PROCESSING") {
      // The cursor stays put deliberately: advancing here would skip this run's
      // results forever, since the next poll would see the id as already done.
      return { rows: [], cursor, note: "run in progress" };
    }

    if (state !== "COMPLETED") {
      // FAILED or REJECTED_NO_FUNDS. Same reasoning — leave the cursor so a
      // later run can be picked up, and surface why nothing arrived.
      return { rows: [], cursor, note: `run ${state.toLowerCase().replace(/_/g, " ")}` };
    }

    const rows =
      cfg.entity === "person"
        ? await pageProfiles(ctx, run.id)
        : await pageCompanies(ctx, run.id);

    return { rows, cursor: { ...cursor, last_run_id: run.id } };
  },
};

/* ------------------------------------------------------------------ */
/* Result paging                                                       */
/* ------------------------------------------------------------------ */

/**
 * Only arrivals become rows. "departed" is the opposite of a discovery, and
 * "stayed" was imported by an earlier run — the dedupe index would drop it
 * anyway, but asking for it would cost credits per result to learn nothing.
 */
const ARRIVALS = ["joined", "returned"] as const;

async function pageProfiles(ctx: Ctx, savedSearchRunId: string): Promise<DiscoveredRow[]> {
  const rows: DiscoveredRow[] = [];
  let cursor: string | null | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await ctx.fiber.call("/v1/saved-search/run/profiles", "post", {
      savedSearchRunId,
      statuses: [...ARRIVALS],
      pageSize: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });

    for (const entry of res.data.output.profiles) {
      const identityKey = profileIdentity(entry.profile);
      if (!identityKey) continue; // a profile we cannot address is not a row
      rows.push({
        identityKey,
        values: {
          "LinkedIn URL": identityKey,
          Name: fullName(entry.profile) ?? "",
        },
      });
    }

    cursor = res.data.output.nextCursor;
    if (!cursor) break;
  }

  return rows;
}

async function pageCompanies(ctx: Ctx, savedSearchRunId: string): Promise<DiscoveredRow[]> {
  const rows: DiscoveredRow[] = [];
  let cursor: string | null | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await ctx.fiber.call("/v1/saved-search/run/companies", "post", {
      savedSearchRunId,
      statuses: [...ARRIVALS],
      pageSize: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });

    for (const entry of res.data.output.companies) {
      const identityKey = companyIdentity(entry.company);
      if (!identityKey) continue;
      rows.push({
        identityKey,
        values: {
          Website: identityKey,
          Name: entry.company.preferred_name ?? entry.company.names?.[0] ?? "",
          // Emitted alongside the domain so a table keyed on LinkedIn still fills.
          "LinkedIn URL": companyLinkedInUrl(entry.company) ?? "",
        },
      });
    }

    cursor = res.data.output.nextCursor;
    if (!cursor) break;
  }

  return rows;
}

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

type ProfileLike = {
  url?: string | null;
  primary_slug?: string | null;
  first_name?: string | null;
  last_name?: string | null;
};

type CompanyLike = {
  domains?: string[] | null;
  linkedin_primary_slug?: string | null;
  names?: string[] | null;
  preferred_name?: string | null;
};

/** A person is their LinkedIn profile URL, built from the slug when absent. */
function profileIdentity(profile: ProfileLike | null | undefined): string | null {
  if (!profile) return null;
  const url =
    profile.url ??
    (profile.primary_slug ? `https://www.linkedin.com/in/${profile.primary_slug}` : null);
  return url ? normalizeUrl(url) : null;
}

/** A company is its primary domain. */
function companyIdentity(company: CompanyLike | null | undefined): string | null {
  const domain = company?.domains?.find((d) => normalizeDomain(d).length > 0);
  return domain ? normalizeDomain(domain) : null;
}

function companyLinkedInUrl(company: CompanyLike): string | null {
  return company.linkedin_primary_slug
    ? normalizeUrl(`https://www.linkedin.com/company/${company.linkedin_primary_slug}`)
    : null;
}

function fullName(profile: ProfileLike): string | null {
  const name = [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim();
  return name.length > 0 ? name : null;
}
