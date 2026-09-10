import { z } from "zod";

import { normalizeUrl } from "@/enrichments/normalize";
import type { Ctx } from "@/enrichments/types";
import type { DiscoveredRow, PollResult, RowSource } from "@/sources/types";

const config = z.object({
  /** Absent until setup() creates the list on Fiber's side. */
  listId: z.string().min(1).optional(),
  entity: z.enum(["person", "company"]),
  /** Rule type slugs from listAvailableTrackerRules, e.g. "new_funding_round". */
  ruleIds: z.array(z.string().min(1)),
  /** LinkedIn slugs or domains to start watching immediately. */
  seedIdentifiers: z.array(z.string().min(1)).optional(),
});

type Config = z.infer<typeof config>;

const PAGE_SIZE = 100;
const MAX_PAGES = 10;
/** The cursor carries a bounded tail of ids, not the whole history. */
const MAX_SEEN_IDS = 500;
const REFRESH_INTERVAL_DAYS = 7;

/**
 * A tracker list watches entities and emits a signal when one of them changes —
 * a company raises a round, a person changes job. Each signal becomes a row
 * carrying the reason it arrived.
 *
 * The cursor is a timestamp plus a bounded tail of signal ids. The timestamp
 * does the work; the ids exist because several signals can share one
 * observedAt, and a timestamp alone would either re-import them every poll or
 * skip the ones it did not happen to see first.
 */
export const fiberSourceTracker: RowSource<Config> = {
  kind: "tracker",
  id: "fiber.source.tracker",
  label: "Tracker",
  description:
    "Watch companies or people and add a row the moment one of them changes.",
  // As with the saved search source, config.entity is what actually branches.
  entity: "company",
  config,
  configFields: [
    { key: "entity", label: "Track", type: "string" },
    { key: "ruleIds", label: "Rules", type: "json" },
    { key: "seedIdentifiers", label: "Seed with", type: "json" },
    { key: "listId", label: "Existing list id", type: "string" },
  ],

  identityFor(item: unknown): string | null {
    const signal = item as SignalLike | null;
    if (!signal) return null;

    const url =
      signal.linkedinUrl ??
      (signal.linkedinSlug ? linkedInUrlFor(signal.entityType, signal.linkedinSlug) : null);
    return url ? normalizeUrl(url) : null;
  },

  /**
   * Creates the list, attaches the rules, and seeds it. Returns the list id for
   * the API route to merge into the stored config.
   */
  async setup(cfg: Config, ctx: Ctx): Promise<Partial<Config>> {
    if (cfg.listId) return {};

    const entityType = cfg.entity;

    /**
     * Each rule is attached twice: once for real, and once as a dummy. Dummy
     * rules are skipped by scheduled runs and are the only thing fire-dummy can
     * fire, so this is what makes "Fire test signal" work against a live key
     * without a real funding round. Both are free to create.
     */
    const trackingRules = cfg.ruleIds.flatMap((type) => [
      { type, entityType },
      { type, entityType, isDummy: true },
    ]) as never;

    const listPath =
      entityType === "person" ? "/v1/tracker/person-lists" : "/v1/tracker/company-lists";

    const created = await ctx.fiber.call(listPath as "/v1/tracker/company-lists", "post", {
      name: `OpenCeramic ${entityType} tracker`,
      refreshIntervalDays: REFRESH_INTERVAL_DAYS,
      trackingRules,
    });
    const listId = created.data.output.id;

    const seeds = cfg.seedIdentifiers ?? [];
    if (seeds.length > 0) {
      if (entityType === "person") {
        await ctx.fiber.call(
          "/v1/tracker/person-lists/{listId}/people",
          "put",
          { people: seeds.map((value) => personIdentifier(value)) },
          { listId },
        );
      } else {
        await ctx.fiber.call(
          "/v1/tracker/company-lists/{listId}/companies",
          "put",
          { companies: seeds.map((value) => companyIdentifier(value)) },
          { listId },
        );
      }
    }

    return { listId };
  },

  async poll(cfg: Config, cursor: Record<string, unknown>, ctx: Ctx): Promise<PollResult> {
    if (!cfg.listId) {
      return { rows: [], cursor, note: "no tracker list yet — run setup first" };
    }

    const since = typeof cursor.last_signal_at === "string" ? cursor.last_signal_at : undefined;
    const seenIds = Array.isArray(cursor.seen_ids)
      ? cursor.seen_ids.filter((id): id is string => typeof id === "string")
      : [];
    const seen = new Set(seenIds);

    const signals: SignalLike[] = [];
    let pageCursor: string | null | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await ctx.fiber.call(
        "/v1/tracker/signals/{listId}",
        "get",
        {
          // Narrows the response; the local filter below is what actually
          // decides, because whether Fiber treats `since` as inclusive is
          // untestable against a sandbox key (every tracker op returns 501).
          ...(since ? { since } : {}),
          ...(pageCursor ? { cursor: pageCursor } : {}),
          pageSize: PAGE_SIZE,
          filter: "all",
        },
        { listId: cfg.listId },
      );

      signals.push(...(res.data.output.signals as SignalLike[]));
      pageCursor = res.data.output.nextCursor;
      if (!pageCursor) break;
    }

    /**
     * `>=` rather than `>`, with seen_ids doing the tie-break. A strict `>`
     * would silently drop a second signal sharing the newest timestamp; `>=`
     * alone would re-import the first one every poll.
     */
    const fresh = signals.filter((s) => {
      if (!s?.id || seen.has(s.id)) return false;
      if (since && s.observedAt < since) return false;
      return true;
    });

    const rows: DiscoveredRow[] = [];
    for (const signal of fresh) {
      const identityKey = fiberSourceTracker.identityFor(signal);
      if (!identityKey) continue; // an entity we cannot address is not a row
      rows.push({
        identityKey,
        values: { "LinkedIn URL": identityKey },
        signal: {
          kind: signal.type,
          reason: signal.summary ?? signal.methodology ?? signal.type,
          occurred_at: signal.eventDate ?? signal.observedAt,
          raw_id: signal.id,
        },
      });
    }

    // Advanced across every signal returned, not just the ones that became
    // rows: a signal skipped for having no LinkedIn identity is still seen, and
    // re-reading it on the next poll would never produce anything either.
    const newest = signals.reduce<string | undefined>(
      (max, s) => (s?.observedAt && (!max || s.observedAt > max) ? s.observedAt : max),
      since,
    );

    return {
      rows,
      cursor: {
        ...cursor,
        ...(newest ? { last_signal_at: newest } : {}),
        seen_ids: boundedSeenIds(signals, seenIds),
      },
    };
  },
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

type SignalLike = {
  id: string;
  entityType: "company" | "person";
  linkedinSlug: string | null;
  linkedinUrl: string | null;
  type: string;
  summary: string | null;
  methodology?: string | null;
  observedAt: string;
  eventDate?: string | null;
};

function linkedInUrlFor(entityType: "company" | "person", slug: string): string {
  const segment = entityType === "person" ? "in" : "company";
  return `https://www.linkedin.com/${segment}/${slug}`;
}

/** Newest first, capped — an unbounded cursor would grow without limit. */
function boundedSeenIds(signals: SignalLike[], previous: string[]): string[] {
  const ids = [...signals.map((s) => s?.id).filter(Boolean), ...previous];
  return [...new Set(ids)].slice(0, MAX_SEEN_IDS);
}

/** A seed is a LinkedIn URL, a bare slug, or (for companies) a domain. */
function personIdentifier(value: string): { linkedinUrl?: string; linkedinSlug?: string } {
  return value.includes("/") ? { linkedinUrl: value } : { linkedinSlug: value };
}

function companyIdentifier(value: string): {
  linkedinUrl?: string;
  linkedinSlug?: string;
  domain?: string;
} {
  if (value.includes("/")) return { linkedinUrl: value };
  return value.includes(".") ? { domain: value } : { linkedinSlug: value };
}
