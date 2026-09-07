import { z } from "zod";

import { normalizeUrl } from "@/enrichments/normalize";
import type { Ctx, Enrichment, PollResult } from "@/enrichments/types";

const inputs = z.object({ linkedin_url: z.string().min(1) });

const output = z.object({
  x_handle: z.string().nullable(),
  instagram_handle: z.string().nullable(),
});

type Input = z.infer<typeof inputs>;
type Output = z.infer<typeof output>;

const PLATFORMS = ["TWITTER", "INSTAGRAM"] as const;

export const fiberSocialHandles: Enrichment<Input, Output> = {
  id: "fiber.social.handles",
  version: 1,
  label: "Social handles",
  description: "Find a person's X and Instagram handles from their LinkedIn profile.",
  entity: "any",
  mode: "async",
  inputs,
  output,
  outputFields: [
    { key: "x_handle", label: "X handle", type: "string" },
    { key: "instagram_handle", label: "Instagram handle", type: "string" },
  ],
  // https://api.fiber.ai/ai-docs/socialMediaLookupTrigger.md — 3 credits per
  // platform searched, and we search two.
  estimateCredits: () => 3 * PLATFORMS.length,
  cacheKey: (input) => `fiber.social.handles:1:${normalizeUrl(input.linkedin_url)}`,

  async start(input, ctx: Ctx): Promise<{ handle: string }> {
    const { data } = await ctx.fiber.call("/v1/social-media-lookup/trigger", "post", {
      person: { inputType: "linkedinUrl", linkedinUrl: normalizeUrl(input.linkedin_url) },
      platforms: [...PLATFORMS],
    });
    return { handle: data.output.socialMediaFinderRunId };
  },

  async poll(handle, ctx: Ctx): Promise<PollResult<Output>> {
    const { data } = await ctx.fiber.call("/v1/social-media-lookup/polling", "post", {
      socialMediaFinderRunId: handle,
    });

    const { status, data: results } = data.output;

    if (status === "pending" || status === "in_progress") return { state: "pending" };

    if (status === "failed") {
      return {
        state: "failed",
        error: { code: "lookup_failed", message: "Social media lookup failed", retryable: false },
      };
    }

    const person = results[0];
    // Completed with nothing found is a successful null, not a failure.
    if (!person || person.outcome === "NO_CANDIDATES_FOUND" || person.candidates.length === 0) {
      return { state: "done", value: null };
    }

    const pick = (platform: (typeof PLATFORMS)[number]) =>
      person.candidates
        .filter((c) => c.platform === platform)
        // The API ranks by confidence; take the most confident.
        .sort((a, b) => b.confidenceOutOf10 - a.confidenceOutOf10)[0]?.handle ?? null;

    return {
      state: "done",
      value: { x_handle: pick("TWITTER"), instagram_handle: pick("INSTAGRAM") },
    };
  },
};
