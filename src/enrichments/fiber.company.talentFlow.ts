import { z } from "zod";

import { normalizeUrl } from "@/enrichments/normalize";
import type { Ctx, Enrichment } from "@/enrichments/types";

const inputs = z.object({
  linkedin_url: z.string().min(1),
  /** "joiners" = where they hire from; "leavers" = where alumni go. */
  direction: z.enum(["joiners", "leavers"]).default("joiners"),
});

const output = z.object({
  direction: z.string(),
  people_analysed: z.number(),
  top_source: z.string().nullable(),
  top_source_share: z.number().nullable(),
  top_sources: z.string().nullable(),
  median_tenure_months: z.number().nullable(),
  median_years_experience: z.number().nullable(),
});

type Input = z.infer<typeof inputs>;
type Output = z.infer<typeof output>;

/**
 * Where a company's people come from, and where they go.
 *
 * Chosen deliberately over another firmographic lookup: it answers a question
 * you cannot get from a company record at all. "Who does this company lose
 * engineers to" is a competitive signal, and it is a different *shape* of
 * enrichment — an aggregate over thousands of profiles rather than a row of
 * attributes — which is a useful stress test of the cell-value contract.
 */
export const fiberCompanyTalentFlow: Enrichment<Input, Output> = {
  id: "fiber.company.talentFlow",
  version: 1,
  label: "Talent flow",
  description:
    "Where a company hires from, or where its alumni go — the companies it trades people with.",
  entity: "company",
  mode: "sync",
  inputs,
  output,
  outputFields: [
    { key: "top_source", label: "Top counterpart", type: "string" },
    { key: "top_source_share", label: "Share %", type: "number" },
    { key: "top_sources", label: "Top 5", type: "string" },
    { key: "people_analysed", label: "People analysed", type: "number" },
    { key: "median_tenure_months", label: "Median tenure (mo)", type: "number" },
    { key: "median_years_experience", label: "Median experience (yrs)", type: "number" },
    { key: "direction", label: "Direction", type: "string" },
  ],
  // https://api.fiber.ai/ai-docs/getTalentFlow.md — 5 credits per report.
  estimateCredits: () => 5,
  // Direction is part of the key: joiners and leavers are different questions.
  cacheKey: (input) =>
    `fiber.company.talentFlow:1:${normalizeUrl(input.linkedin_url)}|${input.direction}`,
  // Large companies take up to two minutes, so this is worth caching for longer.
  ttlSeconds: 30 * 24 * 60 * 60,
  concurrency: 2, // documented rate limit is 30/min

  async run(input, ctx: Ctx): Promise<Output | null> {
    const { data } = await ctx.fiber.call("/v1/talent-flow", "post", {
      company: { identifier: "linkedinUrl", value: normalizeUrl(input.linkedin_url) },
      direction: input.direction,
      dateRange: {},
    });

    const result = data.output;
    // A company with no measurable movement is a successful empty result.
    if (result.peopleCount === 0) return null;

    const ranked = [...result.companyBuckets].sort((a, b) => b.count - a.count);
    const top = ranked[0];

    return {
      direction: result.direction,
      people_analysed: result.peopleCount,
      top_source: top?.companyName ?? null,
      top_source_share: top ? Math.round(top.percent * 10) / 10 : null,
      top_sources: ranked.slice(0, 5).map((b) => b.companyName).join(", ") || null,
      median_tenure_months: result.tenureMonths?.median ?? null,
      median_years_experience: result.yearsOfExperience?.median ?? null,
    };
  },
};
