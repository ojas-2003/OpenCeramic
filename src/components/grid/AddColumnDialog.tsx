"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { sourceOptionsFor } from "@/components/grid/sourceOptions";
import { tableKey } from "@/components/grid/useTableRun";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/apiClient";
import type { Column, EnrichmentMeta } from "@/lib/types";
import { cn } from "cn";

export function AddColumnDialog({
  open,
  onOpenChange,
  tableId,
  tableEntity,
  columns,
  enrichments,
  /** When set, the dialog edits this column's mapping instead of adding one. */
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tableId: string;
  tableEntity: "person" | "company";
  columns: Column[];
  enrichments: EnrichmentMeta[];
  editing?: Column | null;
}) {
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<EnrichmentMeta | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Editing skips the picker: the adapter is already chosen.
  const editKey = editing?.id ?? null;
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  if (editing && loadedFor !== editKey) {
    setLoadedFor(editKey);
    setPicked(enrichments.find((e) => e.id === editing.enrichmentId) ?? null);
    setInputs({ ...(editing.config?.inputs ?? {}) });
    setName(editing.name);
    setError(null);
  }

  const byId = useMemo(() => new Map(enrichments.map((e) => [e.id, e])), [enrichments]);
  const available = enrichments.filter((e) => e.entity === "any" || e.entity === tableEntity);

  const reset = () => {
    setPicked(null);
    setInputs({});
    setName("");
    setError(null);
    setLoadedFor(null);
  };

  const create = useMutation({
    mutationFn: async () => {
      const response = editing
        ? await fetch(`/api/columns/${editing.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: name.trim() || picked!.label, config: { inputs } }),
          })
        : await fetch(`/api/tables/${tableId}/columns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enrichment_id: picked!.id,
          name: name.trim() || picked!.label,
          config: { inputs },
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new ApiError(response.status, body.error);
      return body;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: tableKey(tableId) });
      onOpenChange(false);
      reset();
    },
    onError: (e: Error) => setError(e.message),
  });

  const missing = picked
    ? picked.inputs.filter((i) => i.required && !inputs[i.key]).map((i) => i.key)
    : [];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing ? `Edit ${editing.name}` : picked ? picked.label : "Add enrichment column"}
          </DialogTitle>
          <DialogDescription>
            {picked ? picked.description : `Enrichments available for ${tableEntity} tables.`}
          </DialogDescription>
        </DialogHeader>

        {!picked ? (
          <ul className="flex flex-col gap-2">
            {available.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => {
                    setPicked(e);
                    setName(e.label);
                  }}
                  className="w-full rounded-md border p-3 text-left hover:bg-accent"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{e.label}</span>
                    <Badge variant="outline">{e.mode}</Badge>
                    <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                      {e.estimatedCreditsPerRow ?? "?"} cr/row
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{e.description}</p>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex flex-col gap-4">
            {picked.inputs.map((input) => {
              const options = sourceOptionsFor(input.accepts, columns, byId, editing?.id);
              const chosen = inputs[input.key];
              return (
                <div key={input.key}>
                  <label className="mb-1 flex items-center gap-2 text-xs font-medium">
                    {input.key}
                    {input.required ? null : (
                      <span className="text-muted-foreground">(optional)</span>
                    )}
                  </label>
                  {options.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No compatible column yet — add one that produces a {input.accepts.join(" or ")}.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {options.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() =>
                            setInputs((prev) =>
                              prev[input.key] === option.value
                                ? Object.fromEntries(Object.entries(prev).filter(([k]) => k !== input.key))
                                : { ...prev, [input.key]: option.value },
                            )
                          }
                          className={cn(
                            "rounded-md border px-2 py-1 text-xs",
                            chosen === option.value ? "border-foreground bg-accent" : "hover:bg-accent",
                          )}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  )}
                  {chosen ? (
                    <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                      {input.key} ← {options.find((o) => o.value === chosen)?.label}
                    </p>
                  ) : null}
                </div>
              );
            })}

            <div>
              <label className="mb-1 block text-xs font-medium">Column name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        )}

        <DialogFooter>
          {picked ? (
            <>
              <Button variant="outline" onClick={() => (editing ? onOpenChange(false) : reset())}>
                {editing ? "Cancel" : "Back"}
              </Button>
              <Button
                disabled={missing.length > 0 || create.isPending}
                onClick={() => create.mutate()}
              >
                {create.isPending
                  ? "Saving…"
                  : missing.length > 0
                    ? `Map ${missing.join(", ")}`
                    : editing
                      ? "Save mapping"
                      : "Add column"}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
