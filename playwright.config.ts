import { defineConfig, devices } from "@playwright/test";

/**
 * The smoke tests drive the real stack: Next.js, Postgres and the Inngest dev
 * server. They are deliberately not part of `pnpm test` — those 292 unit tests
 * run with no network, no database and no key, and that is worth keeping.
 *
 * `pnpm test:e2e` starts both services; Docker must be running.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  // A full demo run is 150 cells across four levels, including an async adapter
  // that sleeps between polls.
  timeout: 5 * 60 * 1000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  // Skipped when E2E_BASE_URL points at an already-running app or a deployment.
  ...(process.env.E2E_BASE_URL
    ? {}
    : {
        webServer: {
          command: "docker compose up -d inngest && pnpm dev",
          url: "http://localhost:3000",
          reuseExistingServer: true,
          timeout: 120_000,
        },
      }),
});
