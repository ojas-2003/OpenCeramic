import { defineConfig } from "drizzle-kit";

// drizzle-kit runs outside Next.js, so it does not pick up .env.local on its own.
try {
  process.loadEnvFile(".env.local");
} catch {
  // Falls back to the ambient environment (CI, Vercel).
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL },
});
