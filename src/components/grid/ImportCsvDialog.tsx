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
const MOSAIC_POLL_MS = 3000;
const MOSAIC_MAX_POLLS = 40; // 2 minutes

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
  const [mode, setMode] = useState<"file" | "mosaic">("file");
  const [sourceUrl, setSourceUrl] = useState("");
  const [mosaicNote, setMosaicNote] = useState<string | null>(null);

  const existing = new Set(columns.filter((c) => c.kind === "input").map((c) => c.name));

  const reset = () => {
    setRows([]);
    setHeaders([]);
    setError(null);
    setSourceUrl("");
    setMosaicNote(null);
  };

  /**
   * Mosaic heals the file on Fiber's side. It takes a public URL rather than an
   * upload, so this path asks for a link; the file tab stays for local files.
   */
  async function healWithMosaic() {
    setBusy(true);
    setError(null);
    setMosaicNote("Starting Mosaic…");
    try {
      const startRes = await fetch(`/api/tables/${tableId}/import/mosaic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source_url: sourceUrl.trim() }),
      });
      const started = await startRes.json();
      if (!startRes.ok) throw new Error(started.error?.message ?? "Could not start Mosaic");
      setMosaicNote(started.isFreeTrialRun ? "Running (free trial run)…" : "Running…");

      for (let attempt = 0; attempt < MOSAIC_MAX_POLLS; attempt++) {
        await new Promise((r) => setTimeout(r, MOSAIC_POLL_MS));
        const pollRes = await fetch(
          `/api/tables/${tableId}/import/mosaic?runId=${encodeURIComponent(started.runId)}`,
        );
        const poll = await pollRes.json();
        if (!pollRes.ok) throw new Error(poll.error?.message ?? "Mosaic polling failed");

        if (poll.status === "failed") throw new Error("Mosaic could not heal that file");
        if (poll.status !== "done") {
          setMosaicNote(`Healing… ${poll.stats?.outputRows ?? 0} rows so far`);
          continue;
        }

        await queryClient.invalidateQueries({ queryKey: tableKey(tableId) });
        const s = poll.stats;
        onDone(
          `Mosaic healed ${poll.rowsCreated} rows` +
            (s ? ` · ${s.rowsWhereProfileFound} profiles found · ${s.rowsWithErrors} with errors` : ""),
        );
        onOpenChange(false);
        reset();
        return;
      }
      throw new Error("Mosaic did not finish within two minutes");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMosaicNote(null);
    } finally {
      setBusy(false);
    }
  }

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
          <DialogTitle>Import rows</DialogTitle>
          <DialogDescription>
            {mode === "file"
              ? "The first row is treated as headers. New headers become input columns."
              : "Fiber Mosaic repairs a messy CSV, TXT, XLSX or public Google Sheet before it becomes rows."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1.5">
          {(["file", "mosaic"] as const).map((m) => (
            <Button
              key={m}
              type="button"
              size="sm"
              variant={mode === m ? "default" : "outline"}
              onClick={() => {
                setMode(m);
                reset();
              }}
            >
              {m === "file" ? "Upload a clean CSV" : "Heal with Mosaic"}
            </Button>
          ))}
        </div>

        {mode === "mosaic" ? (
          <div className="flex flex-col gap-2">
            <Input
              placeholder="https://docs.google.com/spreadsheets/d/… or a direct file link"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Mosaic fetches the file itself, so the link must be publicly reachable. It
              normalises headers, repairs partial records and resolves mixed identifier types,
              then the healed columns become input columns here.
            </p>
            {mosaicNote ? <p className="text-xs">{mosaicNote}</p> : null}
          </div>
        ) : (
          <Input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onFile(file);
            }}
          />
        )}

        {mode === "file" && headers.length > 0 ? (
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
          {mode === "mosaic" ? (
            <Button disabled={!sourceUrl.trim() || busy} onClick={healWithMosaic}>
              {busy ? "Healing…" : "Heal and import"}
            </Button>
          ) : (
            <Button disabled={rows.length === 0 || busy} onClick={submit}>
              {busy ? "Importing…" : `Import ${rows.length || ""} rows`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
