import type { ColumnConfig, EntityType } from "@/db/schema";
import { edgesFromColumns, PlanError, topoSortLevels } from "@/engine/planner";
import type { AnyEnrichment } from "@/enrichments/types";

/**
 * Column validation, kept pure so it can be tested without a database.
 * The route loads the table and hands the pieces in.
 */

export type ColumnLike = {
  id: string;
  kind: "input" | "enrichment";
  config: ColumnConfig;
};

export type ValidateColumnInput = {
  tableEntity: EntityType;
  /** Every column already on the table. */
  existing: ColumnLike[];
  /** The adapter, or undefined when enrichment_id is unknown. */
  adapter: AnyEnrichment | undefined;
  config: ColumnConfig;
  /** Set when editing an existing column, so it replaces rather than adds. */
  columnId?: string;
};

export type ColumnValidationError = {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type InputKeySpec = {
  key: string;
  required: boolean;
  /** Scalar kinds this input will accept, probed from its schema. */
  accepts: Array<"string" | "number" | "boolean">;
};

type ProbeSchema = { safeParse(v: unknown): { success: boolean } };

/**
 * Input keys an adapter declares, whether each must be mapped, and what it
 * accepts. Everything is probed from the Zod schema rather than declared
 * separately, so an adapter cannot drift out of sync with its own picker.
 */
export function adapterInputKeys(adapter: AnyEnrichment): InputKeySpec[] {
  const shape = (adapter.inputs as unknown as { shape?: Record<string, ProbeSchema> }).shape;
  if (!shape) return [];

  return Object.entries(shape).map(([key, schema]) => {
    const accepts: InputKeySpec["accepts"] = [];
    if (schema.safeParse("probe").success) accepts.push("string");
    if (schema.safeParse(1).success) accepts.push("number");
    if (schema.safeParse(true).success) accepts.push("boolean");

    return {
      key,
      // A key that accepts undefined is optional or has a default, so the user
      // does not have to map a column to it.
      required: !schema.safeParse(undefined).success,
      accepts,
    };
  });
}

/** An outputField type, reduced to the scalar kind it produces. */
export function fieldKindOf(type: string): "string" | "number" | "boolean" {
  if (type === "number") return "number";
  return "string"; // string, url, email and json all arrive as strings in a chip
}

export function validateColumn(input: ValidateColumnInput): ColumnValidationError | null {
  const { adapter, config, existing, tableEntity } = input;

  if (!adapter) {
    return { status: 400, code: "unknown_enrichment", message: "No such enrichment is registered" };
  }

  if (adapter.entity !== "any" && adapter.entity !== tableEntity) {
    return {
      status: 400,
      code: "entity_mismatch",
      message: `"${adapter.label}" applies to ${adapter.entity} tables, not ${tableEntity} tables`,
      details: { adapterEntity: adapter.entity, tableEntity },
    };
  }

  const declared = adapterInputKeys(adapter);
  const declaredKeys = new Set(declared.map((d) => d.key));
  const mapped = config?.inputs ?? {};

  for (const key of Object.keys(mapped)) {
    if (!declaredKeys.has(key)) {
      return {
        status: 400,
        code: "unknown_input",
        message: `"${adapter.label}" has no input called "${key}"`,
        details: { expected: [...declaredKeys] },
      };
    }
  }

  const missing = declared.filter((d) => d.required && !(d.key in mapped)).map((d) => d.key);
  if (missing.length > 0) {
    return {
      status: 400,
      code: "unmapped_input",
      message: `Map a source column for: ${missing.join(", ")}`,
      details: { missing },
    };
  }

  // An adapter whose inputs are all optional (kitchenSink takes domain OR name)
  // still needs at least one, or the column can never produce anything.
  if (declared.length > 0 && Object.keys(mapped).length === 0) {
    return {
      status: 400,
      code: "unmapped_input",
      message: `Map a source column for at least one of: ${[...declaredKeys].join(", ")}`,
      details: { expected: [...declaredKeys] },
    };
  }

  const byId = new Map(existing.map((c) => [c.id, c]));
  for (const [key, sourceColumnId] of Object.entries(mapped)) {
    // Step 10 introduces a "<column_id>.<field>" form; the column id is the
    // part before the dot.
    const sourceId = String(sourceColumnId).split(".")[0];
    if (!byId.has(sourceId)) {
      return {
        status: 400,
        code: "unknown_source_column",
        message: `Input "${key}" is mapped to a column that is not in this table`,
        details: { key, sourceColumnId },
      };
    }
    if (sourceId === input.columnId) {
      return {
        status: 400,
        code: "cycle",
        message: "A column cannot take its own output as an input",
        details: { columnId: input.columnId },
      };
    }
  }

  // Would the new edges close a loop?
  const columnId = input.columnId ?? "__new__";
  const graph: Array<{ id: string; config: ColumnConfig }> = [
    ...existing.filter((c) => c.id !== columnId).map((c) => ({ id: c.id, config: c.config })),
    { id: columnId, config },
  ];
  const nodes = graph.map((c) => c.id);

  try {
    topoSortLevels(edgesFromColumns(graph), nodes);
  } catch (e) {
    if (e instanceof PlanError && e.code === "cycle") {
      return {
        status: 400,
        code: "cycle",
        message: "That mapping would create a cycle between columns",
        details: e.details,
      };
    }
    throw e;
  }

  return null;
}
