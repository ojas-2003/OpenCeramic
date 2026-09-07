"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { api } from "@/lib/apiClient";

export default function Home() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [entity, setEntity] = useState<"company" | "person">("company");

  const tables = useQuery({ queryKey: ["tables"], queryFn: api.listTables });

  const create = useMutation({
    mutationFn: () => api.createTable(name.trim(), entity),
    onSuccess: () => {
      setOpen(false);
      setName("");
      void queryClient.invalidateQueries({ queryKey: ["tables"] });
    },
  });

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">OpenCeramic</h1>
          <p className="text-sm text-muted-foreground">Enrichment tables built on Fiber AI.</p>
        </div>
        <Button onClick={() => setOpen(true)}>New table</Button>
      </div>

      {tables.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}

      {tables.data?.tables.length === 0 ? (
        <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
          No tables yet. Create one to get started.
        </p>
      ) : null}

      <ul className="flex flex-col gap-2">
        {tables.data?.tables.map((table) => (
          <li key={table.id}>
            <Link
              href={`/tables/${table.id}`}
              className="flex items-center gap-3 rounded-md border px-4 py-3 text-sm hover:bg-accent"
            >
              <span className="font-medium">{table.name}</span>
              <Badge variant="secondary">{table.entityType}</Badge>
            </Link>
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
