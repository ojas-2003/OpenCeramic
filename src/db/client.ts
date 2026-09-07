import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

type DrizzleClient = ReturnType<typeof drizzle>;

let client: DrizzleClient | null = null;

/**
 * Resolved on first query, not on import.
 *
 * Next evaluates every route module while building to collect page data, so a
 * connection made at import time would make `next build` require a live
 * DATABASE_URL. The build should compile without one; a missing variable is a
 * request-time failure, not a compile-time one.
 */
function connect(): DrizzleClient {
  if (client) return client;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  client = drizzle(neon(connectionString));
  return client;
}

export const db = new Proxy({} as DrizzleClient, {
  get: (_target, property, receiver) => Reflect.get(connect(), property, receiver),
  has: (_target, property) => Reflect.has(connect(), property),
}) as DrizzleClient;

export type Db = DrizzleClient;
