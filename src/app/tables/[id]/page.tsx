"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { use, useMemo, useState } from "react";

import { AddColumnDialog } from "@/components/grid/AddColumnDialog";
import { CellSheet } from "@/components/grid/CellSheet";
import { ImportCsvDialog } from "@/components/grid/ImportCsvDialog";
import { RunConfirmDialog, type RunRequest } from "@/components/grid/RunConfirmDialog";
import { Grid } from "@/components/grid/Grid";
import { TableHeader } from "@/components/grid/TableHeader";
import { tableKey, useRunPolling, useStartRun } from "@/components/grid/useTableRun";
import { useToast } from "@/components/Toaster";
import { api } from "@/lib/apiClient";
import { cellKey, type Cell } from "@/lib/types";

export default function TablePage({ params }: { params: Promise<{ id: string }> }) {
  const { id: tableId } = use(params);
  const queryClient = useQueryClient();
  const toast = useToast();

  const [runId, setRunId] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ rowId: string; columnId: string } | null>(null);
  // Every run is proposed here first and priced before anything is spent.
  const [proposed, setProposed] = useState<RunRequest | null>(null);
  const [addingColumn, setAddingColumn] = useState(false);
  const [importing, setImporting] = useState(false);

  const table = useQuery({ queryKey: tableKey(tableId), queryFn: () => api.getTable(tableId) });
  const enrichments = useQuery({ queryKey: ["enrichments"], queryFn: api.enrichments });

  const { run, active } = useRunPolling(tableId, runId);
  const { start, pending, error, clearError } = useStartRun(tableId, (id) => {
    setRunId(id);
    setProposed(null);
  });

  const removeColumn = useMutation({
    mutationFn: api.deleteColumn,
    onSuccess: () => {
      toast.notify("Column deleted");
      void queryClient.invalidateQueries({ queryKey: tableKey(tableId) });
    },
    onError: (e: Error) => toast.fail(e.message),
  });
  const renameColumn = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.renameColumn(id, name),
    onSuccess: () => {
      toast.notify("Column renamed");
      void queryClient.invalidateQueries({ queryKey: tableKey(tableId) });
    },
    onError: (e: Error) => toast.fail(e.message),
  });

  const cellsByKey = useMemo(() => {
    const map = new Map<string, Cell>();
    for (const cell of table.data?.cells ?? []) map.set(cellKey(cell.rowId, cell.columnId), cell);
    return map;
  }, [table.data?.cells]);

  const enrichmentsById = useMemo(
    () => new Map((enrichments.data?.enrichments ?? []).map((e) => [e.id, e])),
    [enrichments.data],
  );

  if (table.isLoading) return <Placeholder>Loading…</Placeholder>;
  if (table.isError) return <Placeholder>Could not load this table.</Placeholder>;
  if (!table.data) return <Placeholder>Not found.</Placeholder>;

  const { columns, rows } = table.data;
  const selectedCell = selected ? cellsByKey.get(cellKey(selected.rowId, selected.columnId)) : undefined;
  const selectedColumn = selected ? columns.find((c) => c.id === selected.columnId) : undefined;

  return (
    <main className="flex h-screen flex-col">
      <TableHeader
        table={table.data.table}
        rowCount={rows.length}
        run={run}
        runActive={active}
        starting={pending}
        onRunTable={() => setProposed({ scope: "table", target: { column_ids: [] } })}
        onAddColumn={() => setAddingColumn(true)}
        onImport={() => setImporting(true)}
      />

      {error ? (
        <button
          type="button"
          onClick={clearError}
          className="border-b bg-destructive/10 px-4 py-2 text-left text-xs text-destructive"
        >
          {error} — dismiss
        </button>
      ) : null}

      {rows.length === 0 ? (
        <Placeholder>
          <div className="flex flex-col items-center gap-3">
            <p>This table has no rows yet.</p>
            <button
              type="button"
              onClick={() => setImporting(true)}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
            >
              Import CSV
            </button>
          </div>
        </Placeholder>
      ) : (
        <Grid
          columns={columns}
          rows={rows}
          cells={cellsByKey}
          enrichments={enrichmentsById}
          onCellClick={(rowId, columnId) => setSelected({ rowId, columnId })}
          onRunColumn={(columnId) => setProposed({ scope: "column", target: { column_ids: [columnId] } })}
          onForceColumn={(columnId) =>
            setProposed({ scope: "column", target: { column_ids: [columnId] }, force: true })
          }
          onRenameColumn={(columnId) => {
            const current = columns.find((c) => c.id === columnId);
            const name = window.prompt("Column name", current?.name ?? "");
            if (name && name !== current?.name) renameColumn.mutate({ id: columnId, name });
          }}
          onDeleteColumn={(columnId) => {
            if (window.confirm("Delete this column and its cells?")) removeColumn.mutate(columnId);
          }}
        />
      )}

      <RunConfirmDialog
        tableId={tableId}
        request={proposed}
        confirming={pending}
        onCancel={() => setProposed(null)}
        onConfirm={(request) => start(request)}
      />

      <AddColumnDialog
        open={addingColumn}
        onOpenChange={setAddingColumn}
        tableId={tableId}
        tableEntity={table.data.table.entityType}
        columns={columns}
        enrichments={enrichments.data?.enrichments ?? []}
      />

      <ImportCsvDialog
        open={importing}
        onOpenChange={setImporting}
        tableId={tableId}
        columns={columns}
        onDone={toast.notify}
      />

      <CellSheet
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
        cell={selectedCell}
        column={selectedColumn}
        rerunning={pending}
        onRerun={() => {
          if (!selected) return;
          setProposed({
            scope: "cell",
            target: { column_ids: [selected.columnId], row_ids: [selected.rowId] },
            force: true,
          });
          setSelected(null);
        }}
      />
    </main>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
      {children}
    </div>
  );
}
