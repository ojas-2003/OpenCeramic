"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { Cell, Column } from "@/lib/types";

/** Where a value came from, which is the question users ask most. */
export function CellSheet({
  open,
  onOpenChange,
  cell,
  column,
  onRerun,
  rerunning,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cell: Cell | undefined;
  column: Column | undefined;
  onRerun: () => void;
  rerunning: boolean;
}) {
  const provenance = (cell?.provenance ?? null) as Record<string, unknown> | null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {column?.name ?? "Cell"}
            {cell ? <Badge variant="secondary">{cell.status}</Badge> : null}
          </SheetTitle>
          <SheetDescription>
            {column?.enrichmentId ?? "Input column"}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-5 px-4 pb-6">
          {cell?.errorCode ? (
            <Section title="Error">
              <p className="font-mono text-xs text-destructive">{cell.errorCode}</p>
              <p className="mt-1 text-xs text-muted-foreground">{cell.errorMessage}</p>
            </Section>
          ) : null}

          <Section title="Value">
            <Pre>{cell?.value === undefined ? "" : JSON.stringify(cell.value, null, 2)}</Pre>
          </Section>

          <Section title="Provenance">
            {provenance && Object.keys(provenance).length > 0 ? (
              <Pre>{JSON.stringify(provenance, null, 2)}</Pre>
            ) : (
              <p className="text-xs text-muted-foreground">Nothing recorded yet.</p>
            )}
          </Section>

          {column?.kind === "enrichment" ? (
            <Button onClick={onRerun} disabled={rerunning} className="w-full">
              {rerunning ? "Starting…" : "Re-run cell"}
            </Button>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Pre({ children }: { children: React.ReactNode }) {
  return (
    <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">
      {children}
    </pre>
  );
}
