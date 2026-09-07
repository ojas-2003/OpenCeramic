"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";

import { CellChip } from "@/components/grid/CellChip";
import { ColumnMenu } from "@/components/grid/ColumnMenu";
import { cellKey, type Cell, type Column, type EnrichmentMeta, type Row } from "@/lib/types";
import { cn } from "cn";

const ROW_HEIGHT = 36;
const COL_WIDTH = "minmax(180px, 1fr)";

export function Grid({
  columns,
  rows,
  cells,
  enrichments,
  onCellClick,
  onRunColumn,
  onForceColumn,
  onRenameColumn,
  onDeleteColumn,
}: {
  columns: Column[];
  rows: Row[];
  cells: Map<string, Cell>;
  enrichments: Map<string, EnrichmentMeta>;
  onCellClick: (rowId: string, columnId: string) => void;
  onRunColumn: (columnId: string) => void;
  onForceColumn: (columnId: string) => void;
  onRenameColumn: (columnId: string) => void;
  onDeleteColumn: (columnId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const template = `48px ${columns.map(() => COL_WIDTH).join(" ")}`;
  const byId = new Map(columns.map((c) => [c.id, c]));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="overflow-x-auto">
        <div className="min-w-max">
          <div
            className="sticky top-0 z-[1] grid border-b bg-muted/40 text-xs"
            style={{ gridTemplateColumns: template }}
          >
            <div className="px-2 py-2 text-muted-foreground">#</div>
            {columns.map((column) => (
              <div key={column.id} className="flex items-center gap-1 border-l px-2 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{column.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {sourceHint(column, byId)}
                  </div>
                </div>
                {column.kind === "enrichment" ? (
                  <ColumnMenu
                    column={column}
                    onRun={() => onRunColumn(column.id)}
                    onForceRun={() => onForceColumn(column.id)}
                    onEdit={() => onRenameColumn(column.id)}
                    onDelete={() => onDeleteColumn(column.id)}
                  />
                ) : null}
              </div>
            ))}
          </div>

          <div ref={scrollRef} className="max-h-[calc(100vh-9rem)] overflow-y-auto">
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const row = rows[virtualRow.index];
                return (
                  <div
                    key={row.id}
                    className="absolute grid w-full border-b hover:bg-muted/30"
                    style={{
                      gridTemplateColumns: template,
                      height: virtualRow.size,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <div className="flex items-center px-2 font-mono text-[11px] text-muted-foreground">
                      {virtualRow.index + 1}
                    </div>
                    {columns.map((column) => {
                      const cell = cells.get(cellKey(row.id, column.id));
                      return (
                        <button
                          key={column.id}
                          type="button"
                          onClick={() => onCellClick(row.id, column.id)}
                          className={cn(
                            "flex min-w-0 items-center border-l px-2 text-left text-xs",
                            "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                          )}
                        >
                          {column.kind === "input" ? (
                            <span className="truncate">{String(cell?.value ?? "")}</span>
                          ) : (
                            <CellChip
                              cell={cell}
                              column={column}
                              meta={enrichments.get(column.enrichmentId ?? "")}
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** "← Website", naming the first mapped source column. */
function sourceHint(column: Column, byId: Map<string, Column>): string {
  if (column.kind === "input") return "input";
  const first = Object.values(column.config?.inputs ?? {})[0];
  if (!first) return column.enrichmentId ?? "";
  const source = byId.get(String(first).split(".")[0]);
  return source ? `← ${source.name}` : (column.enrichmentId ?? "");
}
