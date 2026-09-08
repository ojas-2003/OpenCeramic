import Papa from "papaparse";

import type { FiberClient } from "@/fiber/client";

/**
 * Fiber Mosaic as a row source.
 *
 * Mosaic heals a messy CSV — inconsistent headers, partial records, mixed
 * identifier types — and returns a cleaned file. That is row *sourcing*, not
 * enrichment: it creates rows rather than filling cells, so it lives here
 * rather than behind the Enrichment interface (DESIGN.md section 5.2).
 *
 * It takes a **public HTTPS URL**, not an upload: Fiber fetches the file
 * itself. So this path accepts a link (Google Sheets, Dropbox, a raw file)
 * rather than a browser file handle, and the plain CSV import stays for local
 * files.
 */

export type MosaicOptions = {
  customInstructions?: string;
  /** Mosaic can also reveal contacts while healing; off by default so a repair costs repair money. */
  contactInfo?: { getWorkEmails?: boolean; getPersonalEmails?: boolean; getPhoneNumbers?: boolean };
  includeCompanyDetails?: boolean;
  maxRows?: number;
};

export type MosaicStatus = {
  runId: string;
  status: "pending" | "running" | "done" | "failed";
  rowCount: number | null;
  processedRowCount: number | null;
  isFreeTrialRun: boolean;
  stats: {
    inputRows: number;
    outputRows: number;
    rowsWhereProfileFound: number;
    rowsWithContactDetails: number;
    rowsWithErrors: number;
  } | null;
  outputCsvUrl: string | null;
  reportUrl: string | null;
};

export async function startMosaic(
  fiber: FiberClient,
  sourceUrl: string,
  options: MosaicOptions = {},
): Promise<{ runId: string; isFreeTrialRun: boolean }> {
  const { data } = await fiber.call("/v1/mosaic/start", "post", {
    sourceUrl,
    ...(options.customInstructions ? { customInstructions: options.customInstructions } : {}),
    options: {
      ...(options.contactInfo ? { contactInfo: options.contactInfo } : {}),
      ...(options.includeCompanyDetails === undefined
        ? {}
        : { includeCompanyDetails: options.includeCompanyDetails }),
      ...(options.maxRows === undefined ? {} : { maxRows: options.maxRows }),
    },
  });

  return { runId: data.output.runId, isFreeTrialRun: data.output.isFreeTrialRun };
}

export async function pollMosaic(fiber: FiberClient, runId: string): Promise<MosaicStatus> {
  const { data } = await fiber.call("/v1/mosaic/poll", "post", { runId });
  return data.output.run;
}

/**
 * Downloads the healed CSV and turns it into row objects.
 *
 * The download link is temporary and Fiber-hosted, so this runs server-side —
 * the browser never needs access to it, and no CORS applies.
 */
export async function fetchHealedRows(
  outputCsvUrl: string,
  limit = 1000,
): Promise<{ headers: string[]; rows: Array<Record<string, string>> }> {
  const response = await fetch(outputCsvUrl);
  if (!response.ok) {
    throw new Error(`Could not download the healed CSV (${response.status})`);
  }

  const parsed = Papa.parse<Record<string, string>>(await response.text(), {
    header: true,
    skipEmptyLines: true,
  });

  const rows = parsed.data
    .filter((row) => Object.values(row).some((v) => v?.trim()))
    .slice(0, limit);

  return { headers: parsed.meta.fields ?? [], rows };
}

/** Mosaic emits wide files; a table with 60 columns is unusable. */
export function pickImportColumns(headers: string[], max = 12): string[] {
  return headers.filter((h) => h.trim().length > 0).slice(0, max);
}
