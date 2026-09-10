import type {
  AccountInfo,
  ApiErrorBody,
  EnrichmentMeta,
  PlanResponse,
  Run,
  Cell,
  SourceMeta,
  SourceSummary,
  TablePayload,
  Table,
} from "@/lib/types";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, body: ApiErrorBody["error"]) {
    super(body.message);
    this.name = "ApiError";
    this.status = status;
    this.code = body.code;
    this.details = body.details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...init?.headers } : init?.headers,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (payload as ApiErrorBody | null)?.error;
    throw new ApiError(response.status, error ?? { code: "unknown", message: response.statusText });
  }
  return payload as T;
}

export const api = {
  listTables: () => request<{ tables: Table[] }>("/api/tables"),

  createTable: (name: string, entity_type: "person" | "company") =>
    request<{ table: Table }>("/api/tables", {
      method: "POST",
      body: JSON.stringify({ name, entity_type }),
    }),

  deleteTable: (id: string) => request<{ deleted: boolean }>(`/api/tables/${id}`, { method: "DELETE" }),

  getTable: (id: string) => request<TablePayload>(`/api/tables/${id}`),

  enrichments: () => request<{ enrichments: EnrichmentMeta[] }>("/api/enrichments"),

  account: () => request<AccountInfo>("/api/account"),

  run: (
    tableId: string,
    body: {
      scope: "cell" | "column" | "table";
      target: { column_ids: string[]; row_ids?: string[] };
      force?: boolean;
      dry_run?: boolean;
    },
  ) => request<PlanResponse>(`/api/tables/${tableId}/runs`, { method: "POST", body: JSON.stringify(body) }),

  latestRun: (tableId: string) =>
    request<{ run: Run | null }>(`/api/tables/${tableId}/runs`),

  runStatus: (runId: string, since?: string | null) =>
    request<{ run: Run; cells: Cell[] }>(
      `/api/runs/${runId}${since ? `?since=${encodeURIComponent(since)}` : ""}`,
    ),

  cancelRun: (runId: string) => request<{ run: Run }>(`/api/runs/${runId}/cancel`, { method: "POST" }),

  deleteColumn: (columnId: string) =>
    request<{ deleted: boolean }>(`/api/columns/${columnId}`, { method: "DELETE" }),

  renameColumn: (columnId: string, name: string) =>
    request<{ column: unknown }>(`/api/columns/${columnId}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),

  /* Row sources */

  sourceRegistry: () => request<{ sources: SourceMeta[] }>("/api/sources/registry"),

  sources: (tableId: string) =>
    request<{ sources: SourceSummary[] }>(`/api/sources?table_id=${encodeURIComponent(tableId)}`),

  addSource: (
    tableId: string,
    body: { source_id: string; name: string; config: Record<string, unknown>; auto_enrich: boolean },
  ) =>
    request<{ source: SourceSummary }>(`/api/tables/${tableId}/sources`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  updateSource: (
    id: string,
    body: { name?: string; status?: "active" | "paused" | "error"; auto_enrich?: boolean },
  ) =>
    request<{ source: SourceSummary }>(`/api/sources/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  deleteSource: (id: string) =>
    request<{ deleted: boolean }>(`/api/sources/${id}`, { method: "DELETE" }),

  pollSource: (id: string) =>
    request<{ requested: boolean }>(`/api/sources/${id}/poll`, { method: "POST" }),

  testSignal: (id: string) =>
    request<{ fired: number; signals: Array<{ id: string; summary: string }> }>(
      `/api/sources/${id}/test-signal`,
      { method: "POST" },
    ),
};
