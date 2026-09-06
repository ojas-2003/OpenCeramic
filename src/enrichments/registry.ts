import type { AnyEnrichment, EntityType, RunMode } from "@/enrichments/types";

/**
 * The engine resolves adapters through this registry and never imports one
 * directly — that is the rule that makes "add an enrichment = one file" true.
 */
const registry = new Map<string, AnyEnrichment>();

/** Which methods each mode must implement, and which it must not. */
const REQUIRED_METHODS: Record<RunMode, ReadonlyArray<keyof AnyEnrichment>> = {
  sync: ["run"],
  batch: ["runBatch"],
  async: ["start", "poll"],
};

const ALL_METHODS = ["run", "runBatch", "start", "poll"] as const;

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

/**
 * Validating at register time means a mode/method mismatch is a startup crash
 * rather than a cell that fails halfway through a run.
 */
export function register(enrichment: AnyEnrichment): void {
  const { id, mode } = enrichment;

  if (registry.has(id)) {
    throw new RegistryError(`Enrichment "${id}" is already registered`);
  }

  const required = REQUIRED_METHODS[mode];
  if (!required) {
    throw new RegistryError(`Enrichment "${id}" has unknown mode "${mode}"`);
  }

  for (const method of required) {
    if (typeof enrichment[method] !== "function") {
      throw new RegistryError(`Enrichment "${id}" is mode "${mode}" but does not implement ${String(method)}()`);
    }
  }

  const extra = ALL_METHODS.filter(
    (m) => !required.includes(m) && typeof enrichment[m] === "function",
  );
  if (extra.length > 0) {
    throw new RegistryError(
      `Enrichment "${id}" is mode "${mode}" but also implements ${extra.join(", ")}() — a mode must map to exactly one execution path`,
    );
  }

  registry.set(id, enrichment);
}

export function get(id: string): AnyEnrichment | undefined {
  return registry.get(id);
}

/** Throws rather than returning undefined, for call sites that cannot continue without it. */
export function getOrThrow(id: string): AnyEnrichment {
  const found = registry.get(id);
  if (!found) throw new RegistryError(`Unknown enrichment "${id}"`);
  return found;
}

export function list(): AnyEnrichment[] {
  return [...registry.values()];
}

/** Adapters declared "any" are offered for both person and company tables. */
export function listForEntity(entity: EntityType): AnyEnrichment[] {
  return list().filter((e) => e.entity === entity || e.entity === "any");
}

/** Test-only: the registry is a module singleton. */
export function clear(): void {
  registry.clear();
}
