import type { SourceMeta } from "@/lib/types";

/** Both sources take an entity, and it drives their behaviour rather than a filter. */
export const ENTITY_FIELD = "entity";

/**
 * Turns the flat create-source form into the source's config shape.
 *
 * Most `json` fields are lists — rule slugs, seed domains — and asking someone
 * to type a JSON array for those is unkind, so a bare "a, b" becomes ["a","b"].
 * But searchParams is an object, so anything that starts with { or [ is taken
 * literally instead. Text that looks like JSON and does not parse is passed
 * through untouched, so Zod complains about the value rather than about an
 * array we invented from it.
 */
export function buildConfig(
  source: SourceMeta,
  values: Record<string, string>,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  for (const field of source.configFields) {
    const raw = (values[field.key] ?? "").trim();
    if (!raw) continue;

    if (field.type === "json") {
      config[field.key] = parseJsonField(raw);
    } else if (field.type === "number") {
      config[field.key] = Number(raw);
    } else {
      config[field.key] = raw;
    }
  }

  // ruleIds is required by the tracker's schema even when left blank.
  if (source.kind === "tracker" && !config.ruleIds) config.ruleIds = [];
  return config;
}

function parseJsonField(raw: string): unknown {
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw.split(",").map((part) => part.trim()).filter(Boolean);
}

export function placeholderFor(key: string, type: string): string {
  if (key === "ruleIds") return "new_funding_round, funding_stage_changed";
  if (key === "seedIdentifiers") return "stripe.com, linear.app";
  if (key === "searchParams") return '{"domains": ["stripe.com"]}';
  if (type === "json") return "comma-separated";
  return "";
}
