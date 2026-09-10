import { fiberSourceSavedSearch } from "@/sources/fiber.source.savedSearch";
import { fiberSourceTracker } from "@/sources/fiber.source.tracker";
import { register } from "@/sources/registry";

/**
 * The only module that imports source files. Importing it registers every one.
 * Adding a source is a new file plus a line in registerAll — nothing in
 * src/engine changes.
 */
let registered = false;

function registerAll(): void {
  if (registered) return;
  registered = true;

  register(fiberSourceSavedSearch);
  register(fiberSourceTracker);
}

registerAll();

export {
  get,
  getOrThrow,
  list,
  listForEntity,
  register,
  SourceRegistryError,
} from "@/sources/registry";
export type {
  AnyRowSource,
  Ctx,
  DiscoveredRow,
  FieldSpec,
  PollResult,
  RowSource,
  SourceEntity,
} from "@/sources/types";
