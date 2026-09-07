import type { Column, EnrichmentMeta } from "@/lib/types";

export type SourceOption = {
  /** The config.inputs value: "<column_id>" or "<column_id>.<field_key>". */
  value: string;
  label: string;
  hint: string;
};

const kindOf = (type: string): "string" | "number" | "boolean" =>
  type === "number" ? "number" : "string";

/**
 * Which columns may feed one adapter input.
 *
 * Input columns hold text and are offered to any string input. Enrichment
 * columns hold a JSON object, so each compatible *output field* is offered
 * separately — that is what produces the dotted mapping the engine resolves.
 */
export function sourceOptionsFor(
  accepts: Array<"string" | "number" | "boolean">,
  columns: Column[],
  enrichments: Map<string, EnrichmentMeta>,
  excludeColumnId?: string,
): SourceOption[] {
  const options: SourceOption[] = [];

  for (const column of columns) {
    if (column.id === excludeColumnId) continue;

    if (column.kind === "input") {
      if (accepts.includes("string")) {
        options.push({ value: column.id, label: column.name, hint: "input column" });
      }
      continue;
    }

    const meta = enrichments.get(column.enrichmentId ?? "");
    for (const field of meta?.outputFields ?? []) {
      if (!accepts.includes(kindOf(field.type))) continue;
      options.push({
        value: `${column.id}.${field.key}`,
        label: `${column.name} → ${field.label}`,
        hint: field.type,
      });
    }
  }

  return options;
}
