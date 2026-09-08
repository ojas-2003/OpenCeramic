"use client";

import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, ApiError } from "@/lib/apiClient";

export type RunRequest = {
  scope: "cell" | "column" | "table";
  target: { column_ids: string[]; row_ids?: string[] };
  force?: boolean;
};

/**
 * Prices a run before it happens by planning it with dry_run, which persists
 * nothing. Nothing is billed until Confirm.
 */
export function RunConfirmDialog({
  tableId,
  request,
  onCancel,
  onConfirm,
  confirming,
}: {
  tableId: string;
  request: RunRequest | null;
  onCancel: () => void;
  onConfirm: (request: RunRequest) => void;
  confirming: boolean;
}) {
  const preview = useQuery({
    queryKey: ["dry-run", tableId, request],
    enabled: request !== null,
    retry: false,
    // Never show a cached estimate. Two runs of the same scope produce an
    // identical query key, so without this, reopening the dialog after a run
    // displays the *previous* run's numbers — on the one screen whose entire
    // purpose is telling the user what they are about to spend.
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
    queryFn: () => api.run(tableId, { ...request!, dry_run: true }),
  });

  const account = useQuery({ queryKey: ["account"], queryFn: api.account, staleTime: 60_000 });
  const balance = account.data?.credits?.output?.available ?? null;

  const error = preview.error as ApiError | null;
  const overBudget = error?.code === "over_budget";
  const details = (error?.details ?? {}) as { estimatedCredits?: number; max?: number };

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Run {request?.scope}</DialogTitle>
          <DialogDescription>
            {request?.force ? "Re-runs cells that are already done." : "Skips cells that are already done."}
          </DialogDescription>
        </DialogHeader>

        {preview.isLoading ? <p className="text-sm text-muted-foreground">Planning…</p> : null}

        {overBudget ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <p className="font-medium text-destructive">Over the per-run credit cap</p>
            <p className="mt-1 text-xs text-muted-foreground">
              This run would cost <strong>{details.estimatedCredits}</strong> credits; the cap is{" "}
              <strong>{details.max}</strong> (MAX_CREDITS_PER_RUN). Run a column at a time, or raise
              the cap.
            </p>
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">{error.message}</p>
        ) : null}

        {preview.data ? (
          <p className="text-sm">
            Run <strong>{preview.data.counts.total}</strong> cells (
            {preview.data.counts.cached} cached) · est.{" "}
            <strong>{preview.data.estimatedCredits}</strong> credits
            {balance === null ? null : <> · balance {balance.toLocaleString()}</>}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={!preview.data || preview.data.counts.total === 0 || confirming}
            onClick={() => request && onConfirm(request)}
          >
            {confirming ? "Starting…" : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
