import { fiberCompanyKitchenSink } from "@/enrichments/fiber.company.kitchenSink";
import { register } from "@/enrichments/registry";

/**
 * The only module that imports adapters. Importing it registers every one.
 * Adding an enrichment is a new file plus a line here — nothing in src/engine
 * changes.
 */
let registered = false;

function registerAll(): void {
  if (registered) return;
  registered = true;

  register(fiberCompanyKitchenSink);
}

registerAll();

export { get, getOrThrow, list, listForEntity, register, RegistryError } from "@/enrichments/registry";
export type {
  AdapterError,
  AnyEnrichment,
  Ctx,
  Enrichment,
  EntityType,
  FieldSpec,
  PollResult,
  RunMode,
} from "@/enrichments/types";
