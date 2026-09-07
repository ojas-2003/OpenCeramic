"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";

import { useToast } from "@/components/Toaster";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/apiClient";

type CacheInfo = {
  total: number;
  live: number;
  expired: number;
  ttlSeconds: number;
  maxCreditsPerRun: number;
};

export default function SettingsPage() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const account = useQuery({ queryKey: ["account"], queryFn: api.account });
  const cache = useQuery({
    queryKey: ["cache"],
    queryFn: async (): Promise<CacheInfo> => (await fetch("/api/cache")).json(),
  });

  const clear = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/cache", { method: "DELETE" });
      if (!response.ok) throw new Error("Could not clear the cache");
      return (await response.json()) as { cleared: number };
    },
    onSuccess: (r) => {
      toast.notify(`Cleared ${r.cleared} cache entries`);
      void queryClient.invalidateQueries({ queryKey: ["cache"] });
    },
    onError: (e: Error) => toast.fail(e.message),
  });

  const credits = account.data?.credits as { output?: { available?: number; max?: number } } | null;
  const limits = (account.data?.rate_limits as { output?: { rateLimits?: Array<{ path: string; max: number; windowSeconds: number | null }> } } | null)
    ?.output?.rateLimits;

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
      <div>
        <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">← Back</Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Read-only, except for clearing the cache.</p>
      </div>

      <Card title="Fiber credits">
        {account.data?.unavailable?.credits ? (
          <Muted>Unavailable — {account.data.unavailable.credits}</Muted>
        ) : (
          <p className="font-mono text-sm">
            {credits?.output?.available?.toLocaleString() ?? "—"} available
            {credits?.output?.max ? ` of ${credits.output.max.toLocaleString()}` : ""}
          </p>
        )}
      </Card>

      <Card title="Rate limits">
        {account.data?.unavailable?.rate_limits ? (
          <Muted>Unavailable — {account.data.unavailable.rate_limits}</Muted>
        ) : limits?.length ? (
          <ul className="flex flex-col gap-1 font-mono text-xs">
            {limits.slice(0, 8).map((l) => (
              <li key={l.path} className="flex justify-between gap-4">
                <span className="truncate text-muted-foreground">{l.path}</span>
                <span>{l.max}/{l.windowSeconds ?? "?"}s</span>
              </li>
            ))}
          </ul>
        ) : (
          <Muted>None reported.</Muted>
        )}
      </Card>

      <Card title="Enrichment cache">
        <p className="font-mono text-sm">
          {cache.data?.total ?? "—"} entries · {cache.data?.live ?? "—"} live ·{" "}
          {cache.data?.expired ?? "—"} expired
        </p>
        <Muted>
          TTL {cache.data ? Math.round(cache.data.ttlSeconds / 86400) : "—"} days. Clearing means the
          next run pays full price.
        </Muted>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          disabled={clear.isPending}
          onClick={() => clear.mutate()}
        >
          {clear.isPending ? "Clearing…" : "Clear cache"}
        </Button>
      </Card>

      <Card title="Run budget">
        <p className="font-mono text-sm">
          MAX_CREDITS_PER_RUN = {cache.data?.maxCreditsPerRun ?? "—"}
        </p>
        <Muted>A run planned above this is refused before anything is written.</Muted>
      </Card>
    </main>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border p-4">
      <h2 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-xs text-muted-foreground">{children}</p>;
}
