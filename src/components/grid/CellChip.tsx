"use client";

import { Check, CircleDashed, CircleSlash, Dot, LoaderCircle, X } from "lucide-react";

import type { Cell, Column, EnrichmentMeta } from "@/lib/types";
import { cn } from "cn";

const ICONS = {
  idle: { Icon: Dot, className: "text-muted-foreground" },
  pending: { Icon: CircleDashed, className: "text-muted-foreground" },
  running: { Icon: LoaderCircle, className: "text-blue-600 animate-spin" },
  done: { Icon: Check, className: "text-emerald-600" },
  failed: { Icon: X, className: "text-destructive" },
  skipped: { Icon: CircleSlash, className: "text-amber-600" },
} as const;

/**
 * One line per cell: a status icon plus the first non-null output field, so a
 * column of results reads down the page without opening anything.
 */
export function CellChip({
  cell,
  meta,
}: {
  cell: Cell | undefined;
  column: Column;
  meta: EnrichmentMeta | undefined;
}) {
  const status = cell?.status ?? "idle";
  const { Icon, className } = ICONS[status];

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon className={cn("size-3.5 shrink-0", className)} aria-label={status} />
      <span className="truncate font-mono text-xs text-foreground/80">{summarise(cell, meta)}</span>
    </span>
  );
}

export function summarise(cell: Cell | undefined, meta: EnrichmentMeta | undefined): string {
  if (!cell) return "";
  if (cell.status === "failed") return cell.errorCode ?? "failed";
  if (cell.status === "skipped") {
    const because = (cell.provenance as { skipped_because?: { reason?: string } } | null)
      ?.skipped_because;
    return because?.reason ?? "skipped";
  }
  if (cell.status !== "done") return "";

  const value = cell.value;
  if (value === null || value === undefined) return "—";
  if (typeof value !== "object") return String(value);

  const record = value as Record<string, unknown>;
  // Prefer the adapter's declared field order, so the summary is predictable.
  const keys = meta?.outputFields.map((f) => f.key) ?? Object.keys(record);
  for (const key of keys) {
    const candidate = record[key];
    if (candidate !== null && candidate !== undefined && candidate !== "") {
      return typeof candidate === "object" ? JSON.stringify(candidate) : String(candidate);
    }
  }
  return "—";
}
