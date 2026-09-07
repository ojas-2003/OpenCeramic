import type { CellProvenance } from "@/db/schema";

export type CacheEntry = { value: unknown; credits: number };

export interface CacheStore {
  getMany(keys: string[]): Promise<Map<string, CacheEntry>>;
  set(key: string, value: unknown, credits: number, ttlSeconds: number): Promise<void>;
}

export const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

export function cacheTtlSeconds(): number {
  const parsed = Number(process.env.CACHE_TTL_SECONDS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_SECONDS;
}

/**
 * Postgres-backed cache. Imports the db lazily so the engine stays testable
 * without DATABASE_URL set.
 */
export function createDbCache(): CacheStore {
  return {
    async getMany(keys: string[]): Promise<Map<string, CacheEntry>> {
      const found = new Map<string, CacheEntry>();
      if (keys.length === 0) return found;

      const [{ db }, { enrichmentCache }, { and, gt, inArray }] = await Promise.all([
        import("@/db/client"),
        import("@/db/schema"),
        import("drizzle-orm"),
      ]);

      const rows = await db
        .select()
        .from(enrichmentCache)
        .where(
          and(
            inArray(enrichmentCache.cacheKey, keys),
            // An expired row is a miss, not a hit.
            gt(enrichmentCache.expiresAt, new Date()),
          ),
        );

      for (const row of rows) {
        found.set(row.cacheKey, { value: row.value, credits: row.credits });
      }
      return found;
    },

    async set(key, value, credits, ttlSeconds): Promise<void> {
      const [{ db }, { enrichmentCache }] = await Promise.all([
        import("@/db/client"),
        import("@/db/schema"),
      ]);

      const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
      await db
        .insert(enrichmentCache)
        .values({ cacheKey: key, value, credits, expiresAt })
        .onConflictDoUpdate({
          target: enrichmentCache.cacheKey,
          set: { value, credits, expiresAt },
        });
    },
  };
}

/** In-memory store for tests and for the fake client's in-memory mode. */
export class MemoryCache implements CacheStore {
  private readonly entries = new Map<string, { entry: CacheEntry; expiresAt: number }>();

  async getMany(keys: string[]): Promise<Map<string, CacheEntry>> {
    const found = new Map<string, CacheEntry>();
    for (const key of keys) {
      const hit = this.entries.get(key);
      if (hit && hit.expiresAt > Date.now()) found.set(key, hit.entry);
    }
    return found;
  }

  async set(key: string, value: unknown, credits: number, ttlSeconds: number): Promise<void> {
    this.entries.set(key, {
      entry: { value, credits },
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  get size(): number {
    return this.entries.size;
  }
}

/** The planner only needs to know which keys exist. */
export async function cacheLookup(keys: string[]): Promise<Set<string>> {
  const found = await createDbCache().getMany(keys);
  return new Set(found.keys());
}

export function cacheHitProvenance(entry: CacheEntry): CellProvenance {
  return { cache_hit: true, credits: 0, latency_ms: 0 };
}

/** For the settings page: how much is cached, and how much of it is stale. */
export async function cacheStats(): Promise<{ total: number; live: number; expired: number }> {
  const [{ db }, { enrichmentCache }, { sql }] = await Promise.all([
    import("@/db/client"),
    import("@/db/schema"),
    import("drizzle-orm"),
  ]);

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      live: sql<number>`count(*) filter (where ${enrichmentCache.expiresAt} > now())::int`,
    })
    .from(enrichmentCache);

  const total = row?.total ?? 0;
  const live = row?.live ?? 0;
  return { total, live, expired: total - live };
}

/** Empties the cache. The next run pays full price. */
export async function clearCache(): Promise<number> {
  const [{ db }, { enrichmentCache }] = await Promise.all([
    import("@/db/client"),
    import("@/db/schema"),
  ]);
  const deleted = await db.delete(enrichmentCache).returning({ key: enrichmentCache.cacheKey });
  return deleted.length;
}
