import { z } from "zod";

import { normalizeUrl } from "@/enrichments/normalize";
import type { Ctx, Enrichment } from "@/enrichments/types";

const inputs = z.object({
  company_linkedin_url: z.string().min(1),
  title_query: z.string().min(1).default("CEO OR Founder"),
});

const output = z.object({
  linkedin_url: z.string().nullable(),
  full_name: z.string().nullable(),
  title: z.string().nullable(),
  location: z.string().nullable(),
});

type Input = z.infer<typeof inputs>;
type Output = z.infer<typeof output>;

/**
 * "CEO OR Founder" becomes one term per alternative in jobTitleV2.anyOf, which
 * is Fiber's own OR. Search ranking decides the winner; we take result[0].
 *
 * Fiber also exposes jobTitleRewrite (POST /v1/typeahead/job-title, "Job Title
 * Synonym Expansion") which would expand "CEO" into its synonyms, and
 * jobTitleV2 supports static-groups ("founder", "c-suite", "board-member") that
 * cover this query natively. Neither is used here: the extra call costs credits
 * and latency on every cell, and plain terms are enough for the demo. Worth
 * revisiting if match rates disappoint.
 */
function titleTerms(query: string): Array<{ type: "term"; term: string }> {
  return query
    .split(/\s+OR\s+/i)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((term) => ({ type: "term" as const, term }));
}

export const fiberPeopleFindAtCompany: Enrichment<Input, Output> = {
  id: "fiber.people.findAtCompany",
  version: 1,
  label: "Find person at company",
  description:
    "Find the best-matching person at a company by job title, e.g. the CEO or a founder.",
  entity: "company",
  mode: "sync",
  inputs,
  output,
  outputFields: [
    { key: "linkedin_url", label: "LinkedIn URL", type: "url" },
    { key: "full_name", label: "Full name", type: "string" },
    { key: "title", label: "Title", type: "string" },
    { key: "location", label: "Location", type: "string" },
  ],
  // https://api.fiber.ai/ai-docs/peopleSearch.md — 1 credit per profile found.
  estimateCredits: () => 1,
  cacheKey: (input) =>
    `fiber.people.findAtCompany:1:${normalizeUrl(input.company_linkedin_url)}|${input.title_query.trim().toLowerCase()}`,

  async run(input, ctx: Ctx): Promise<Output | null> {
    const { data } = await ctx.fiber.call("/v1/people-search", "post", {
      currentCompanies: [{ linkedinSlugOrURL: normalizeUrl(input.company_linkedin_url) }],
      searchParams: { jobTitleV2: { anyOf: titleTerms(input.title_query) } },
      pageSize: 1,
    });

    const person = data.output.data[0];
    if (!person) return null;

    return {
      linkedin_url: person.url ?? null,
      full_name: person.name ?? null,
      // headline is marketing copy ("VP of Eng at X"); the job title is cleaner.
      title: person.current_job?.title ?? person.headline ?? null,
      location: person.locality ?? null,
    };
  },
};
