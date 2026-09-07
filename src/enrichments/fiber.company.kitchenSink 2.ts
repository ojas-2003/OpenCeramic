import { z } from "zod";

import { normalizeDomain } from "@/enrichments/normalize";
import type { Ctx, Enrichment } from "@/enrichments/types";

const inputs = z
  .object({
    domain: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
  })
  .refine((v) => Boolean(v.domain || v.name), {
    message: "Provide a domain or a name",
  });

const output = z.object({
  linkedin_url: z.string().nullable(),
  name: z.string().nullable(),
  domain: z.string().nullable(),
  industry: z.string().nullable(),
  headcount: z.number().nullable(),
  hq_location: z.string().nullable(),
  founded_year: z.number().nullable(),
  funding_total: z.number().nullable(),
  funding_stage: z.string().nullable(),
  description: z.string().nullable(),
});

type Input = z.infer<typeof inputs>;
type Output = z.infer<typeof output>;

export const fiberCompanyKitchenSink: Enrichment<Input, Output> = {
  id: "fiber.company.kitchenSink",
  version: 1,
  label: "Resolve company",
  description:
    "Look up a company by domain or name and return its LinkedIn URL, size, location, industry and funding.",
  entity: "company",
  mode: "sync",
  inputs,
  output,
  outputFields: [
    { key: "linkedin_url", label: "LinkedIn URL", type: "url" },
    { key: "name", label: "Name", type: "string" },
    { key: "domain", label: "Domain", type: "string" },
    { key: "industry", label: "Industry", type: "string" },
    { key: "headcount", label: "Headcount", type: "number" },
    { key: "hq_location", label: "HQ location", type: "string" },
    { key: "founded_year", label: "Founded", type: "number" },
    { key: "funding_total", label: "Funding total", type: "number" },
    { key: "funding_stage", label: "Funding stage", type: "string" },
    { key: "description", label: "Description", type: "string" },
  ],
  // https://api.fiber.ai/ai-docs/kitchenSinkCompany.md — 2 credits per lookup.
  estimateCredits: () => 2,
  cacheKey: (input) =>
    `fiber.company.kitchenSink:1:${normalizeDomain(input.domain)}|${(input.name ?? "").trim().toLowerCase()}`,

  async run(input, ctx: Ctx): Promise<Output | null> {
    const { data } = await ctx.fiber.call("/v1/kitchen-sink/company", "post", {
      ...(input.domain ? { companyDomain: { value: normalizeDomain(input.domain) } } : {}),
      ...(input.name ? { companyName: { value: input.name } } : {}),
    });

    const company = data.output.data[0];
    // No match is a successful null, not a failure — see CLAUDE.md.
    if (!company) return null;

    const industry = company.li_industries?.find((i) => i.primary) ?? company.li_industries?.[0];
    const location = company.location_consensus;

    return {
      linkedin_url: company.linkedin_primary_slug
        ? `https://www.linkedin.com/company/${company.linkedin_primary_slug}`
        : null,
      name: company.preferred_name ?? company.names?.[0] ?? null,
      domain: company.domains?.[0] ?? null,
      industry: industry?.name ?? null,
      // The API reports a headcount band; the lower bound is the safe estimate.
      headcount: company.employee_count_consensus?.gte ?? company.employee_count_consensus?.lte ?? null,
      hq_location:
        [location?.city, location?.state_name, location?.country_name].filter(Boolean).join(", ") || null,
      founded_year: parseYear(company.founded_on_consensus),
      funding_total: company.total_funding_consensus ?? null,
      funding_stage: company.funding_stage ?? null,
      description: company.short_description ?? company.long_description ?? null,
    };
  },
};

/** founded_on_consensus is an ISO-ish date string; only the year is useful here. */
function parseYear(value: string | null | undefined): number | null {
  if (!value) return null;
  const year = Number.parseInt(value.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}
