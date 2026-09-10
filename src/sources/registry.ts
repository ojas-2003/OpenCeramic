import type { AnyRowSource, SourceEntity } from "@/sources/types";

/**
 * The poller resolves sources through this registry and never imports one
 * directly — the same rule that makes "add an enrichment = one file" true for
 * src/enrichments (CLAUDE.md, "Row sources").
 */
const registry = new Map<string, AnyRowSource>();

/** Every source lives under this namespace; the last segment names its kind. */
const ID_NAMESPACE = "fiber.source.";

export class SourceRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceRegistryError";
  }
}

/**
 * "fiber.source.savedSearch" -> "saved_search". The id is written in camelCase
 * to match the Fiber operation names it wraps, the kind in snake_case to match
 * the source_kind enum in Postgres; this is the one place they have to agree.
 */
function kindFromId(id: string): string {
  return id.slice(ID_NAMESPACE.length).replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * Validating at register time means an id/kind mismatch is a startup crash
 * rather than a source that polls happily and writes rows the UI cannot group.
 */
export function register(source: AnyRowSource): void {
  const { id, kind } = source;

  if (registry.has(id)) {
    throw new SourceRegistryError(`Source "${id}" is already registered`);
  }

  if (!id.startsWith(ID_NAMESPACE)) {
    throw new SourceRegistryError(`Source "${id}" must be named "${ID_NAMESPACE}<name>"`);
  }

  const expected = kindFromId(id);
  if (expected !== kind) {
    throw new SourceRegistryError(
      `Source "${id}" declares kind "${kind}" but its id implies "${expected}"`,
    );
  }

  registry.set(id, source);
}

export function get(id: string): AnyRowSource | undefined {
  return registry.get(id);
}

/** Throws rather than returning undefined, for call sites that cannot continue without it. */
export function getOrThrow(id: string): AnyRowSource {
  const found = registry.get(id);
  if (!found) throw new SourceRegistryError(`Unknown source "${id}"`);
  return found;
}

export function list(): AnyRowSource[] {
  return [...registry.values()];
}

/** A person source has nothing to offer a company table, so the match is exact. */
export function listForEntity(entity: SourceEntity): AnyRowSource[] {
  return list().filter((s) => s.entity === entity);
}

/** Test-only: the registry is a module singleton. */
export function clear(): void {
  registry.clear();
}
