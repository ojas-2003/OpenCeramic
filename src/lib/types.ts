import type { Cell, Column, Row, Run, Table } from "@/db/schema";

export type { Cell, Column, Row, Run, Table };

export type TablePayload = {
  table: Table;
  columns: Column[];
  rows: Row[];
  cells: Cell[];
};

export type EnrichmentMeta = {
  id: string;
  version: number;
  label: string;
  description: string;
  entity: "person" | "company" | "any";
  mode: "sync" | "async" | "batch";
  inputs: Array<{ key: string; required: boolean }>;
  outputFields: Array<{ key: string; label: string; type: string }>;
  estimatedCreditsPerRow: number | null;
};

export type AccountInfo = {
  credits: { output?: { available?: number; max?: number } } | null;
  rate_limits: unknown | null;
  unavailable?: Record<string, string>;
};

export type PlanResponse = {
  runId: string;
  levels: string[][];
  counts: { total: number; cached: number };
  estimatedCredits: number;
  dryRun: boolean;
};

export type ApiErrorBody = { error: { code: string; message: string; details?: unknown } };

export const cellKey = (rowId: string, columnId: string) => `${rowId}:${columnId}`;

export const RUN_ACTIVE_STATUSES = new Set(["planned", "running"]);
