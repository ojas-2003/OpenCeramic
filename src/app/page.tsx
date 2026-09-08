"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/Toaster";
import { api } from "@/lib/apiClient";

export default function Home() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [entity, setEntity] = useState<"company" | "person">("company");

  const tables = useQuery({ queryKey: ["tables"], queryFn: api.listTables });

  const create = useMutation({
    mutationFn: () => api.createTable(name.trim(), entity),
    onSuccess: () => {
      setOpen(false);
      setName("");
      toast.notify("Table created");
      void queryClient.invalidateQueries({ queryKey: ["tables"] });
    },
    onError: (e: Error) => toast.fail(e.message),
  });

  const removeTable = useMutation({
    mutationFn: api.deleteTable,
    onSuccess: () => {
      toast.notify("Table deleted");
      void queryClient.invalidateQueries({ queryKey: ["tables"] });
    },
    onError: (e: Error) => toast.fail(e.message),
  });

  const loadDemo = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/demo", { method: "POST" });
      if (!response.ok) throw new Error("Could not load the demo table");
      return (await response.json()) as { table: { id: string }; rows: number };
    },
    onSuccess: (r) => {
      toast.notify(`Demo table loaded with ${r.rows} rows`);
      void queryClient.invalidateQueries({ queryKey: ["tables"] });
    },
    onError: (e: Error) => toast.fail(e.message),
  });

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">OpenCeramic</h1>
          <p className="text-sm text-muted-foreground">Enrichment tables built on Fiber AI.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/settings" className="text-sm text-muted-foreground hover:text-foreground">
            Settings
          </Link>
          <Button variant="outline" disabled={loadDemo.isPending} onClick={() => loadDemo.mutate()}>
            {loadDemo.isPending ? "Loading…" : "Load demo table"}
          </Button>
          <Button onClick={() => setOpen(true)}>New table</Button>
        </div>
      </div>

      {tables.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}

      {tables.data?.tables.length === 0 ? (
        <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
          No tables yet. Load the demo table to see the seven-column chain, or create your own.
        </p>
      ) : null}

      <ul className="flex flex-col gap-2">
        {tables.data?.tables.map((table) => (
          <li key={table.id} className="group flex items-center gap-2 rounded-md border pr-2 hover:bg-accent">
            <Link
              href={`/tables/${table.id}`}
              className="flex flex-1 items-center gap-3 px-4 py-3 text-sm"
            >
              <span className="font-medium">{table.name}</span>
              <Badge variant="secondary">{table.entityType}</Badge>
            </Link>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Delete ${table.name}`}
              disabled={removeTable.isPending}
              // Deleting a table cascades to its columns, rows and cells, so it
              // is worth one confirmation.
              onClick={() =>
                window.confirm(`Delete "${table.name}" and all of its rows and cells?`) &&
                removeTable.mutate(table.id)
              }
            >
              <Trash2 className="size-4 text-muted-foreground" />
            </Button>
          </li>
        ))}
      </ul>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New table</DialogTitle>
            <DialogDescription>Rows are people or companies; columns are enrichments.</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <Input
              autoFocus
              placeholder="Table name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <div className="flex gap-2">
              {(["company", "person"] as const).map((option) => (
                <Button
                  key={option}
                  type="button"
                  variant={entity === option ? "default" : "outline"}
                  size="sm"
                  onClick={() => setEntity(option)}
                >
                  {option}
                </Button>
              ))}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
