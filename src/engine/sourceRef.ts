import type { Cell } from "@/db/schema";

/**
 * A config.inputs value names where a cell's input comes from.
 *
 * An input column holds a scalar, so the column id alone is enough:
 *     "col-website"
 *
 * An enrichment column holds a JSON object, so the mapping has to name the
 * field as well, or the dependent adapter receives the whole object:
 *     "col-company.linkedin_url"
 */
export type SourceRef = { columnId: string; field: string | null };

export function parseSourceRef(value: string): SourceRef {
  const dot = value.indexOf(".");
  if (dot === -1) return { columnId: value, field: null };
  return { columnId: value.slice(0, dot), field: value.slice(dot + 1) };
}

export type SourceRead =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

/**
 * Reads one input from its source cell. The reasons are user-facing: they end
 * up in provenance.skipped_because so a blank cell explains itself.
 */
export function readSourceValue(cell: Cell | undefined, field: string | null): SourceRead {
  if (!cell) return { ok: false, reason: "source cell has not been created" };
  if (cell.status === "failed") return { ok: false, reason: "source column failed" };
  if (cell.status === "skipped") return { ok: false, reason: "source column was skipped" };
  if (cell.status !== "done") return { ok: false, reason: "source column has not run" };
  if (cell.value === null || cell.value === undefined) {
    return { ok: false, reason: "source value is empty" };
  }

  if (field === null) return { ok: true, value: cell.value };

  if (typeof cell.value !== "object" || Array.isArray(cell.value)) {
    return { ok: false, reason: `source value has no field "${field}"` };
  }

  const inner = (cell.value as Record<string, unknown>)[field];
  if (inner === null || inner === undefined || inner === "") {
    return { ok: false, reason: `source field "${field}" is empty` };
  }
  return { ok: true, value: inner };
}
