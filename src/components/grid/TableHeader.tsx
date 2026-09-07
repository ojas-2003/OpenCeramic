"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/apiClient";
import type { Run, Table } from "@/lib/types";

export function TableHeader({
  table,
  rowCount,
  run,
  runActive,
  onRunTable,
  onAddColumn,
  onImport,
  starting,
}: {
  table: Table;
  rowCount: number;
  run: Run | null;
  runActive: boolean;
  onRunTable: () => void;
  onAddColumn: () => void;
  onImport: () => void;
  starting: boolean;
}) {
  const { data: account } = useQuery({
    queryKey: ["account"],
    queryFn: api.account,
    refetchInterval: 60_000,
  });

  const available = account?.credits?.output?.available ?? null;
  const counts = run?.counts;
  const finished = counts ? counts.done + counts.failed + counts.skipped : 0;
  const total = counts?.total ?? 0;

  return (
    <header className="sticky top-0 z-10 border-b bg-background">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
          ←
        </Link>
        <h1 className="text-base font-semibold tracking-tight">{table.name}</h1>
        <Badge variant="secondary">{table.entityType}</Badge>
        <span className="text-xs text-muted-foreground">{rowCount} rows</span>

        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-muted-foreground" title="Fiber credit balance">
            {available === null ? "credits —" : `${available.toLocaleString()} credits`}
          </span>
          <a
            href={`/api/tables/${table.id}/export`}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Export CSV
          </a>
          <Button size="sm" variant="outline" onClick={onImport}>
            Import CSV
          </Button>
          <Button size="sm" variant="outline" onClick={onAddColumn}>
            Add column
          </Button>
          <Button size="sm" onClick={onRunTable} disabled={starting || runActive}>
            {runActive ? "Running…" : starting ? "Starting…" : "Run table"}
          </Button>
        </div>
      </div>

      {run && total > 0 ? (
        <div className="px-4 pb-2">
          <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-foreground/70 transition-[width] duration-500"
              style={{ width: `${Math.round((finished / total) * 100)}%` }}
            />
          </div>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">
            {run.status} · {finished}/{total} · {counts!.done} done · {counts!.failed} failed ·{" "}
            {counts!.skipped} skipped · {counts!.cache_hits} cached
          </p>
        </div>
      ) : null}
    </header>
  );
}
