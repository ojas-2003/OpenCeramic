import { z } from "zod";

import { normalizeEmail } from "@/enrichments/normalize";
import type { Ctx, Enrichment } from "@/enrichments/types";

const inputs = z.object({ email: z.string().min(1) });

const output = z.object({
  deliverable: z.boolean(),
  status: z.string(),
});

type Input = z.infer<typeof inputs>;
type Output = z.infer<typeof output>;

export const fiberEmailValidate: Enrichment<Input, Output> = {
  id: "fiber.email.validate",
  version: 1,
  label: "Validate email",
  description: "Check whether an email address is deliverable before you send to it.",
  entity: "any",
  mode: "sync",
  inputs,
  output,
  outputFields: [
    { key: "deliverable", label: "Deliverable", type: "string" },
    { key: "status", label: "Status", type: "string" },
  ],
  // https://api.fiber.ai/ai-docs/emailBounceDetection.md — 1 credit per validation.
  estimateCredits: () => 1,
  cacheKey: (input) => `fiber.email.validate:1:${normalizeEmail(input.email)}`,

  async run(input, ctx: Ctx): Promise<Output | null> {
    const { data } = await ctx.fiber.call("/v1/validate-email/single", "post", {
      email: normalizeEmail(input.email),
    });

    const result = data.output;
    // verdict is "ok" | "undeliverable" | "risky" | "inconclusive"; only "ok"
    // is safe to send to.
    return { deliverable: result.verdict === "ok", status: result.verdict };
  },
};
