"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SourceSummary } from "@/lib/types";
import { cn } from "cn";

const DOT: Record<string, string> = {
  active: "bg-emerald-500",
  paused: "bg-amber-500",
  error: "bg-destructive",
};

/** One source: what it is, how it is doing, and the three things you can do to it. */
export function SourceRow({
  source,
  polling,
  onPoll,
  onTestSignal,
  onToggleAutoEnrich,
  onDelete,
  onRunAnyway,
}: {
  source: SourceSummary;
  polling: boolean;
  onPoll: () => void;
  onTestSignal: () => void;
  onToggleAutoEnrich: () => void;
  onDelete: () => void;
  onRunAnyway: () => void;
}) {
  const pausedOnBudget = source.status === "paused" && Boolean(source.errorMessage);

  return (
    <li className="rounded-md border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn("size-2 shrink-0 rounded-full", DOT[source.status] ?? "bg-muted")}
          title={source.status}
        />
        <span className="text-sm font-medium">{source.name}</span>
        <Badge variant="outline">{source.kind === "tracker" ? "tracker" : "saved search"}</Badge>
        <span className="font-mono text-[11px] text-muted-foreground">
          {source.rowCount} row{source.rowCount === 1 ? "" : "s"}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {polling ? "polling…" : `polled ${relativeTime(source.lastPolledAt)}`}
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={onToggleAutoEnrich}
            className={cn(
              "rounded-md border px-2 py-1 text-[11px]",
              source.autoEnrich ? "border-foreground bg-accent" : "text-muted-foreground hover:bg-accent",
            )}
            title="Enrich new rows automatically, without waiting for anyone to press Run"
          >
            auto-enrich {source.autoEnrich ? "on" : "off"}
          </button>
          {source.kind === "tracker" ? (
            <Button size="sm" variant="outline" onClick={onTestSignal} disabled={polling}>
              Fire test signal
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={onPoll} disabled={polling}>
            {polling ? "Polling…" : "Poll now"}
          </Button>
          <button
            type="button"
            onClick={onDelete}
            className="px-1 text-xs text-muted-foreground hover:text-destructive"
            title="Stop polling. Rows it already found are kept."
          >
            ×
          </button>
        </div>
      </div>

      {source.errorMessage ? (
        <div
          className={cn(
            "mt-2 flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-xs",
            source.status === "error"
              ? "bg-destructive/10 text-destructive"
              : "bg-amber-500/10 text-amber-700 dark:text-amber-400",
          )}
        >
          <span className="flex-1">{source.errorMessage}</span>
          {pausedOnBudget ? (
            <Button size="sm" variant="outline" onClick={onRunAnyway}>
              Run anyway
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function relativeTime(value: Date | string | null): string {
  if (!value) return "never";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "never";

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
