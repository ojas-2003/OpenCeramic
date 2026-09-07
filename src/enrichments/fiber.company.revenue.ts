import { z } from "zod";

import { normalizeUrl } from "@/enrichments/normalize";
import type { Ctx, Enrichment } from "@/enrichments/types";

const inputs = z.object({ linkedin_url: z.string().min(1) });

const output = z.object({
  revenue_estimate: z.number().nullable(),
  currency: z.string().nullable(),
  range_low: z.number().nullable(),
  range_high: z.number().nullable(),
});

type Input = z.infer<typeof inputs>;
type Output = z.infer<typeof output>;

export const fiberCompanyRevenue: Enrichment<Input, Output> = {
  id: "fiber.company.revenue",
  version: 1,
  label: "Company revenue",
  description: "Estimate a company's annual revenue from its LinkedIn URL.",
  entity: "company",
  mode: "sync",
  inputs,
  output,
  outputFields: [
    { key: "revenue_estimate", label: "Revenue estimate", type: "number" },
    { key: "currency", label: "Currency", type: "string" },
    { key: "range_low", label: "Range low", type: "number" },
    { key: "range_high", label: "Range high", type: "number" },
  ],
  // https://api.fiber.ai/ai-docs/getCompanyRevenue.md — 4 credits per lookup.
  estimateCredits: () => 4,
  cacheKey: (input) => `fiber.company.revenue:1:${normalizeUrl(input.linkedin_url)}`,

  async run(input, ctx: Ctx): Promise<Output | null> {
    const { data } = await ctx.fiber.call("/v1/company-revenue", "post", {
      companyMetadata: { linkedinUrl: normalizeUrl(input.linkedin_url) },
    });

    const info = data.output.revenueInfo;
    if (!info) return null;

    return {
      // Fiber reports a band; the midpoint is the single-number estimate.
      revenue_estimate: Math.round((info.lowerBound + info.upperBound) / 2),
      // The API does not return a currency. Its revenue figures are USD.
      currency: "USD",
      range_low: info.lowerBound,
      range_high: info.upperBound,
    };
  },
};
