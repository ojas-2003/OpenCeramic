import { z } from "zod";

import { normalizeUrl } from "@/enrichments/normalize";
import type { AdapterError, Ctx, Enrichment } from "@/enrichments/types";

const inputs = z.object({ linkedin_url: z.string().min(1) });

const output = z.object({
  email: z.string().nullable(),
  email_status: z.string().nullable(),
  phone: z.string().nullable(),
});

type Input = z.infer<typeof inputs>;
type Output = z.infer<typeof output>;

/**
 * Fiber documents a batch maximum of 2000 people. We chunk far below that
 * because runBatch has to finish inside one Inngest step: it starts the job and
 * polls it here, with a 3s interval and 20 attempts (60s). Two thousand people
 * would not resolve in that window, and a step that outlives its budget is
 * worse than several smaller ones.
 */
const BATCH_SIZE = 25;
const POLL_INTERVAL_MS = 3_000;
const MAX_POLLS = 20;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const fiberContactReveal: Enrichment<Input, Output> = {
  id: "fiber.contact.reveal",
  version: 1,
  label: "Reveal contact",
  description: "Find a person's work email and phone number from their LinkedIn profile.",
  entity: "any",
  mode: "batch",
  inputs,
  output,
  outputFields: [
    { key: "email", label: "Email", type: "email" },
    { key: "email_status", label: "Email status", type: "string" },
    { key: "phone", label: "Phone", type: "string" },
  ],
  batchSize: BATCH_SIZE,
  // https://api.fiber.ai/ai-docs/startBatchContactDetails.md — 5 credits for
  // phone numbers and emails together.
  estimateCredits: () => 5,
  cacheKey: (input) => `fiber.contact.reveal:1:${normalizeUrl(input.linkedin_url)}`,

  async runBatch(batch, ctx: Ctx): Promise<Array<Output | null | AdapterError>> {
    const urls = batch.map((b) => normalizeUrl(b.linkedin_url));

    const started = await ctx.fiber.call("/v1/contact-details/batch/start", "post", {
      personDetails: urls.map((value) => ({ linkedinUrl: { value } })),
      enrichmentTypes: { getWorkEmails: true, getPhoneNumbers: true },
    });
    const taskId = started.data.output.taskId;

    // Poll before sleeping: a batch that is already done costs no extra wait.
    let page: Awaited<ReturnType<typeof pollOnce>> | null = null;
    for (let attempt = 1; attempt <= MAX_POLLS; attempt++) {
      page = await pollOnce(ctx, taskId);
      if (page.done || page.failed || page.canceled) break;
      if (attempt < MAX_POLLS) await sleep(POLL_INTERVAL_MS);
    }

    if (!page || page.failed || page.canceled) {
      const error: AdapterError = {
        code: page?.failed ? "batch_failed" : "batch_timeout",
        message: page?.failed
          ? "Fiber reported the contact batch as failed"
          : `Batch did not finish within ${(MAX_POLLS * POLL_INTERVAL_MS) / 1000}s`,
        retryable: !page?.failed,
      };
      return batch.map(() => error);
    }

    // Map results back by LinkedIn URL: the response order is not the input order.
    const byUrl = new Map<string, Output>();
    for (const result of page.pageResults) {
      const key = normalizeUrl(result.inputs.linkedinUrl.value);
      const emails = result.outputs?.emails ?? [];
      const phones = result.outputs?.phoneNumbers ?? [];
      // Prefer a work email; fall back to whatever was found.
      const email = emails.find((e) => e.type === "work") ?? emails[0];

      // A row with no email and no phone is "nothing found", which is a null
      // value rather than an object of nulls. That distinction matters
      // downstream: a null source makes the dependent cell skip with a reason,
      // whereas {email: null} would resolve and then fail as invalid_input.
      if (!email && phones.length === 0) continue;

      byUrl.set(key, {
        email: email?.email ?? null,
        email_status: email?.status ?? null,
        phone: phones[0]?.number ?? null,
      });
    }

    // A person Fiber returned nothing for is a successful null, not a failure.
    return urls.map((url) => byUrl.get(url) ?? null);
  },
};

async function pollOnce(ctx: Ctx, taskId: string) {
  const { data } = await ctx.fiber.call("/v1/contact-details/batch/poll", "post", { taskId });
  return data.output;
}
