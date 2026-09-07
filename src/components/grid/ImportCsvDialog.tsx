"use client";

import { useQueryClient } from "@tanstack/react-query";
import Papa from "papaparse";
import { useState } from "react";

import { tableKey } from "@/components/grid/useTableRun";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { Column } from "@/lib/types";

const BATCH = 200;

/**
 * Parses the file in the browser, creates an input column for any header the
 * table does not have yet, then posts rows in batches so a large file does not
 * arrive as one enormous request.
 */
export function ImportCsvDialog({
  open,
  onOpenChange,
  tableId,
  columns,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tableId: string;
  columns: Column[];
  onDone: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<Array<Record<string, string>>>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existing = new Set(columns.filter((c) => c.kind === "input").map((c) => c.name));

  const reset = () => {
    setRows([]);
    setHeaders([]);
    setError(null);
  };

  function onFile(file: File) {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        const parsed = result.data.filter((r) => Object.values(r).some((v) => v?.trim()));
        setHeaders(result.meta.fields ?? []);
        setRows(parsed);
        setError(parsed.length === 0 ? "That file has no data rows." : null);
      },
      error: (e) => setError(e.message),
    });
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      for (const header of headers) {
        if (existing.has(header)) continue;
        const response = await fetch(`/api/tables/${tableId}/columns`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "input", name: header }),
        });
        if (!response.ok) throw new Error(`Could not create column "${header}"`);
      }

      for (let i = 0; i < rows.length; i += BATCH) {
        const response = await fetch(`/api/tables/${tableId}/rows`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rows: rows.slice(i, i + BATCH) }),
        });
        if (!response.ok) throw new Error("Could not add rows");
      }

      await queryClient.invalidateQueries({ queryKey: tableKey(tableId) });
      onDone(`Imported ${rows.length} rows`);
      onOpenChange(false);
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) reset(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Import CSV</DialogTitle>
          <DialogDescription>
            The first row is treated as headers. New headers become input columns.
          </DialogDescription>
        </DialogHeader>

        <Input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFile(file);
          }}
        />

        {headers.length > 0 ? (
          <div className="rounded-md border p-3 text-xs">
            <p className="mb-2 text-muted-foreground">{rows.length} rows · column mapping:</p>
            <ul className="flex flex-col gap-1">
              {headers.map((header) => (
                <li key={header} className="flex items-center justify-between gap-2">
                  <span className="font-mono">{header}</span>
                  <span className="text-muted-foreground">
                    {existing.has(header) ? "→ existing column" : "→ new input column"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={rows.length === 0 || busy} onClick={submit}>
            {busy ? "Importing…" : `Import ${rows.length || ""} rows`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
