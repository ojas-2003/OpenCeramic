"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SourceConfigForm } from "@/components/grid/SourceConfigForm";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/apiClient";
import { buildConfig, ENTITY_FIELD } from "@/lib/sourceConfig";
import type { SourceMeta } from "@/lib/types";
import { cn } from "cn";

export function AddSourceDialog({
  open,
  onOpenChange,
  tableId,
  tableEntity,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tableId: string;
  tableEntity: "person" | "company";
  onAdded: (name: string) => void;
}) {
  const registry = useQuery({ queryKey: ["source-registry"], queryFn: api.sourceRegistry });
  const [picked, setPicked] = useState<SourceMeta | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [autoEnrich, setAutoEnrich] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setPicked(null);
    setValues({});
    setName("");
    setAutoEnrich(true);
    setError(null);
  };

  const create = useMutation({
    mutationFn: () =>
      api.addSource(tableId, {
        source_id: picked!.id,
        name: name.trim() || picked!.label,
        config: buildConfig(picked!, values),
        auto_enrich: autoEnrich,
      }),
    onSuccess: () => {
      onAdded(name.trim() || picked!.label);
      onOpenChange(false);
      reset();
    },
    onError: (e: Error) => setError(e.message),
  });

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
          <DialogTitle>{picked ? picked.label : "Add a row source"}</DialogTitle>
          <DialogDescription>
            {picked
              ? picked.description
              : "A source watches Fiber and adds rows on its own. You never press Run."}
          </DialogDescription>
        </DialogHeader>

        {!picked ? (
          <ul className="flex flex-col gap-2">
            {(registry.data?.sources ?? []).map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => {
                    setPicked(s);
                    setName(s.label);
                    setValues({ [ENTITY_FIELD]: tableEntity });
                  }}
                  className="w-full rounded-md border p-3 text-left hover:bg-accent"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{s.label}</span>
                    <Badge variant="outline">{s.kind === "tracker" ? "tracker" : "saved search"}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{s.description}</p>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex flex-col gap-4">
            <SourceConfigForm
              source={picked}
              values={values}
              onChange={(key, value) => setValues((prev) => ({ ...prev, [key]: value }))}
            />

            <div>
              <label className="mb-1 block text-xs font-medium">Source name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            <button
              type="button"
              onClick={() => setAutoEnrich((v) => !v)}
              className="flex items-center gap-2 text-left text-xs"
            >
              <span
                className={cn(
                  "size-4 rounded border",
                  autoEnrich ? "border-foreground bg-foreground" : "border-muted-foreground",
                )}
              />
              Enrich new rows automatically, capped by MAX_AUTO_CREDITS_PER_POLL
            </button>

            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        )}

        <DialogFooter>
          {picked ? (
            <>
              <Button variant="outline" onClick={reset}>
                Back
              </Button>
              <Button disabled={create.isPending} onClick={() => create.mutate()}>
                {create.isPending ? "Creating…" : "Add source"}
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
