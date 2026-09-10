"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

import { POLL_MS, tableKey } from "@/components/grid/useTableRun";
import { api } from "@/lib/apiClient";
import type { SourceSummary } from "@/lib/types";

export function sourcesKey(tableId: string) {
  return ["sources", tableId] as const;
}

/**
 * The sources on a table, plus the two things that make a poll feel immediate:
 * which sources are mid-poll, and a refetch that only ticks while one is.
 *
 * A poll is asynchronous — the route returns 202 and Inngest does the work — so
 * "in flight" is tracked here by remembering each source's last_polled_at at
 * request time and watching for it to change. No extra timer: this reuses the
 * run loop's interval, and stops as soon as nothing is pending.
 */
export function useSources(tableId: string, onPollSettled?: () => void) {
  const queryClient = useQueryClient();
  // Stamps are compared as strings: the schema types last_polled_at as a Date,
  // but it arrives from the API as an ISO string.
  const [pending, setPending] = useState<Record<string, string>>({});
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const query = useQuery({
    queryKey: sourcesKey(tableId),
    queryFn: () => api.sources(tableId),
    refetchInterval: () => (Object.keys(pendingRef.current).length > 0 ? POLL_MS : false),
  });

  const sources = query.data?.sources ?? [];

  // Clear a source from the pending set once its last_polled_at has moved on.
  const stillPending: Record<string, string> = {};
  for (const [id, startedAt] of Object.entries(pending)) {
    const current = sources.find((s) => s.id === id);
    if (current && stamp(current.lastPolledAt) !== startedAt) continue;
    stillPending[id] = startedAt;
  }
  if (Object.keys(stillPending).length !== Object.keys(pending).length) {
    setPending(stillPending);
    // A poll that just finished may have inserted rows and started a run the
    // grid knows nothing about, so both the rows and that run have to be picked
    // up here.
    void queryClient.invalidateQueries({ queryKey: tableKey(tableId) });
    onPollSettled?.();
  }

  const markPending = useCallback((source: SourceSummary) => {
    setPending((prev) => ({ ...prev, [source.id]: stamp(source.lastPolledAt) }));
  }, []);

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: sourcesKey(tableId) });
  }, [queryClient, tableId]);

  return {
    sources,
    isLoading: query.isLoading,
    polling: (id: string) => id in pending,
    markPending,
    invalidate,
  };
}

/** The mutations one source row needs, sharing a single error channel. */
export function useSourceActions(tableId: string, onError: (message: string) => void) {
  const queryClient = useQueryClient();
  const settle = () => {
    void queryClient.invalidateQueries({ queryKey: sourcesKey(tableId) });
  };

  const poll = useMutation({
    mutationFn: api.pollSource,
    onSuccess: settle,
    onError: (e: Error) => onError(e.message),
  });

  const testSignal = useMutation({
    mutationFn: api.testSignal,
    onSuccess: settle,
    onError: (e: Error) => onError(e.message),
  });

  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Parameters<typeof api.updateSource>[1]) =>
      api.updateSource(id, body),
    onSuccess: settle,
    onError: (e: Error) => onError(e.message),
  });

  const remove = useMutation({
    mutationFn: api.deleteSource,
    onSuccess: () => {
      settle();
      void queryClient.invalidateQueries({ queryKey: tableKey(tableId) });
    },
    onError: (e: Error) => onError(e.message),
  });

  return { poll, testSignal, update, remove };
}

const stamp = (value: Date | string | null): string => (value ? String(value) : "");
