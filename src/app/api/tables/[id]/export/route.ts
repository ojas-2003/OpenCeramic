import { getTableWithData } from "@/db/queries";
import "@/enrichments";
import { get as getEnrichment } from "@/enrichments/registry";
import { cellKey } from "@/lib/types";
import { notFound } from "@/lib/api";

type Params = { params: Promise<{ id: string }> };

/**
 * CSV of the whole table. Input columns keep their name; each enrichment column
 * is flattened to one column per output field, headed "<column>.<field>", so a
 * spreadsheet gets scalars rather than JSON blobs.
 */
export async function GET(_request: Request, { params }: Params): Promise<Response> {
  const { id } = await params;
  const data = await getTableWithData(id);
  if (!data) return notFound("Table");

  const headers: string[] = [];
  const readers: Array<(rowId: string) => unknown> = [];
  const cells = new Map(data.cells.map((c) => [cellKey(c.rowId, c.columnId), c]));

  for (const column of data.columns) {
    if (column.kind === "input") {
      headers.push(column.name);
      readers.push((rowId) => cells.get(cellKey(rowId, column.id))?.value ?? "");
      continue;
    }

    const adapter = getEnrichment(column.enrichmentId ?? "");
    const fields = adapter?.outputFields ?? [];

    if (fields.length === 0) {
      headers.push(column.name);
      readers.push((rowId) => JSON.stringify(cells.get(cellKey(rowId, column.id))?.value ?? ""));
      continue;
    }

    for (const field of fields) {
      headers.push(`${column.name}.${field.key}`);
      readers.push((rowId) => {
        const value = cells.get(cellKey(rowId, column.id))?.value;
        if (value === null || value === undefined || typeof value !== "object") return "";
        return (value as Record<string, unknown>)[field.key] ?? "";
      });
    }
  }

  const lines = [headers.map(csvCell).join(",")];
  for (const row of data.rows) {
    lines.push(readers.map((read) => csvCell(read(row.id))).join(","));
  }

  const filename = `${data.table.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.csv`;
  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  // Quote when the value could otherwise break the row.
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
