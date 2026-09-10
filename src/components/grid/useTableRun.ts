"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "@/lib/apiClient";
import { cellKey, RUN_ACTIVE_STATUSES, type Cell, type TablePayload } from "@/lib/types";

/** One cadence for everything that watches server-side work. */
export const POLL_MS = 1500;

export function tableKey(tableId: string) {
  return ["table", tableId] as const;
}

/**
 * Polls an active run and patches changed cells into the table cache in place.
 * Refetching the whole table every 1.5s would fight the user's scroll position
 * and re-render every row.
 */
export function useRunPolling(tableId: string, runId: string | null) {
  const queryClient = useQueryClient();
  const since = useRef<string | null>(null);

  useEffect(() => {
    since.current = null;
  }, [runId]);

  const { data } = useQuery({
    queryKey: ["run", runId],
    enabled: runId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.run.status;
      return status && !RUN_ACTIVE_STATUSES.has(status) ? false : POLL_MS;
    },
    queryFn: async () => {
      const result = await api.runStatus(runId!, since.current);
      // Advance the cursor so the next poll only asks for newer changes.
      since.current = new Date().toISOString();

      if (result.cells.length > 0) {
        queryClient.setQueryData<TablePayload>(tableKey(tableId), (prev) =>
          prev ? { ...prev, cells: mergeCells(prev.cells, result.cells) } : prev,
        );
      }
      return result;
    },
  });

  const run = data?.run ?? null;
  const active = run !== null && RUN_ACTIVE_STATUSES.has(run.status);

  // One final full refresh when the run ends, to pick up anything the diff missed.
  const settled = useRef<string | null>(null);
  useEffect(() => {
    if (!run || active || settled.current === run.id) return;
    settled.current = run.id;
    void queryClient.invalidateQueries({ queryKey: tableKey(tableId) });
  }, [run, active, queryClient, tableId]);

  return { run, active };
}

function mergeCells(previous: Cell[], incoming: Cell[]): Cell[] {
  const byKey = new Map(previous.map((c) => [cellKey(c.rowId, c.columnId), c]));
  for (const cell of incoming) byKey.set(cellKey(cell.rowId, cell.columnId), cell);
  return [...byKey.values()];
}

/** Starts a run and hands back its id so polling can begin. */
export function useStartRun(tableId: string, onStarted: (runId: string) => void) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (body: Parameters<typeof api.run>[1]) => api.run(tableId, body),
    onSuccess: (plan) => {
      setError(null);
      onStarted(plan.runId);
      void queryClient.invalidateQueries({ queryKey: tableKey(tableId) });
    },
    onError: (e: Error) => setError(e.message),
  });

  const start = useCallback(
    (body: Parameters<typeof api.run>[1]) => mutation.mutate(body),
    [mutation],
  );

  return { start, pending: mutation.isPending, error, clearError: () => setError(null) };
}
