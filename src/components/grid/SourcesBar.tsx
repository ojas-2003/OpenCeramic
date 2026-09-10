"use client";

import { useState } from "react";

import { AddSourceDialog } from "@/components/grid/AddSourceDialog";
import { SourceRow } from "@/components/grid/SourceRow";
import { useSourceActions, useSources } from "@/components/grid/useSources";
import { Button } from "@/components/ui/button";
import type { SourceSummary } from "@/lib/types";

/**
 * The push half of the table, sitting above the grid: what is watching Fiber on
 * this table's behalf, and what it has found.
 */
export function SourcesBar({
  tableId,
  tableEntity,
  onNotify,
  onRunPendingFor,
  onPollSettled,
}: {
  tableId: string;
  tableEntity: "person" | "company";
  onNotify: (message: string) => void;
  /** Opens the existing run confirmation for the rows a paused source left. */
  onRunPendingFor: (source: SourceSummary) => void;
  /** A poll finished; the grid should look for a run it may have started. */
  onPollSettled: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { sources, polling, markPending, invalidate } = useSources(tableId, onPollSettled);
  const actions = useSourceActions(tableId, setError);

  return (
    <section className="border-b bg-muted/20 px-4 py-2">
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-medium text-muted-foreground">
          Sources{sources.length > 0 ? ` (${sources.length})` : ""}
        </h2>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setAdding(true)}>
          Add source
        </Button>
      </div>

      {sources.length === 0 ? (
        <p className="pb-1 text-xs text-muted-foreground">
          Nothing is watching this table yet. A source adds rows on its own when Fiber sees
          something new — a company raises a round, a person changes job.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5 pt-1">
          {sources.map((source) => (
            <SourceRow
              key={source.id}
              source={source}
              polling={polling(source.id)}
              onPoll={() => {
                markPending(source);
                actions.poll.mutate(source.id);
              }}
              onTestSignal={() => {
                markPending(source);
                actions.testSignal.mutate(source.id, {
                  onSuccess: (result) =>
                    onNotify(
                      result.fired > 0
                        ? `Fired ${result.fired} test signal${result.fired === 1 ? "" : "s"} — watching for the row`
                        : "Fiber fired no test signals. Does the list have a dummy rule?",
                    ),
                });
              }}
              onToggleAutoEnrich={() =>
                actions.update.mutate({ id: source.id, auto_enrich: !source.autoEnrich })
              }
              onDelete={() => {
                if (window.confirm(`Stop polling "${source.name}"? Its rows are kept.`)) {
                  actions.remove.mutate(source.id);
                }
              }}
              onRunAnyway={() => onRunPendingFor(source)}
            />
          ))}
        </ul>
      )}

      {error ? (
        <button
          type="button"
          onClick={() => setError(null)}
          className="mt-1 text-left text-xs text-destructive"
        >
          {error} — dismiss
        </button>
      ) : null}

      <AddSourceDialog
        open={adding}
        onOpenChange={setAdding}
        tableId={tableId}
        tableEntity={tableEntity}
        onAdded={(name) => {
          // The new source will not appear until the list is refetched.
          invalidate();
          onNotify(`Source "${name}" is watching this table`);
        }}
      />
    </section>
  );
}
