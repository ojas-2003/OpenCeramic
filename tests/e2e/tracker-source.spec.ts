import { expect, test, type Page } from "@playwright/test";

/**
 * The push model, end to end: attach a tracker to an empty table, fire a test
 * signal, and watch a row arrive and enrich itself with nobody pressing Run.
 *
 * Like the demo-run spec this asserts the engine's contract rather than pixels —
 * that a row appears carrying the signal that produced it, and that its cells
 * reach terminal states on their own.
 */

const TERMINAL = ["done", "failed", "skipped"];
const NON_TERMINAL = ["idle", "pending", "running"];

async function countByStatus(page: Page, statuses: string[]): Promise<number> {
  let total = 0;
  for (const status of statuses) {
    total += await page.locator(`[aria-label="${status}"]`).count();
  }
  return total;
}

test("a tracker signal creates a row that enriches itself", async ({ page, request }) => {
  // Setup through the API: the table and its columns are not what is under
  // test, and building them by hand would be most of the runtime.
  const table = await (
    await request.post("/api/tables", {
      data: { name: `E2E — tracker ${Date.now()}`, entity_type: "company" },
    })
  ).json();
  const tableId = table.table.id as string;

  const linkedin = await (
    await request.post(`/api/tables/${tableId}/columns`, {
      data: { name: "LinkedIn URL", kind: "input" },
    })
  ).json();

  await request.post(`/api/tables/${tableId}/columns`, {
    data: {
      enrichment_id: "fiber.company.revenue",
      name: "Revenue",
      config: { inputs: { linkedin_url: linkedin.column.id } },
    },
  });

  await page.goto(`/tables/${tableId}`);

  await test.step("the table starts empty, with nothing watching it", async () => {
    await expect(page.getByText("Nothing is watching this table yet")).toBeVisible();
    expect(await countByStatus(page, TERMINAL)).toBe(0);
  });

  await test.step("attach a tracker through the Add source dialog", async () => {
    await page.getByRole("button", { name: "Add source" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /^Tracker/ }).click();

    // Rule slugs are typed as a comma-separated list, not JSON.
    await dialog.getByPlaceholder("new_funding_round").fill("new_funding_round");
    await dialog.getByRole("button", { name: "Add source" }).click();

    // Creating it runs setup(), which makes the list on Fiber's side. The
    // source then has to appear in the bar without a reload.
    await expect(page.getByRole("button", { name: "Fire test signal" })).toBeVisible({
      timeout: 30_000,
    });
  });

  const sourceRow = page.locator("li", { hasText: "Poll now" }).first();
  await expect(sourceRow).toBeVisible();

  await test.step("fire a test signal", async () => {
    await sourceRow.getByRole("button", { name: "Fire test signal" }).click();
  });

  await test.step("a row arrives on its own, carrying the signal that caused it", async () => {
    // No Run was pressed. The poller inserts the row and starts the run itself.
    await expect
      .poll(() => page.locator('[aria-label*="new_funding_round"]').count(), {
        timeout: 90_000,
        intervals: [2000],
        message: "no row arrived from the tracker signal",
      })
      .toBeGreaterThan(0);

    // The origin chip says a source put this row here, and its tooltip carries
    // the reason. A CSV row would have neither.
    const chip = page.locator('[aria-label*="new_funding_round"]').first();
    await expect(chip).toHaveAttribute("aria-label", /raised|Series/);
  });

  await test.step("its cells reach terminal states without anyone pressing Run", async () => {
    await expect
      .poll(() => countByStatus(page, NON_TERMINAL), {
        timeout: 3 * 60 * 1000,
        intervals: [2000],
        message: "cells still idle, pending or running",
      })
      .toBe(0);

    expect(await countByStatus(page, TERMINAL)).toBeGreaterThan(0);
  });

  await test.step("polling again adds nothing, because the cursor moved", async () => {
    const before = await page.locator('[aria-label*="new_funding_round"]').count();

    await sourceRow.getByRole("button", { name: "Poll now" }).click();
    await page.waitForTimeout(15_000);

    // The same signals come back; the cursor and the identity index between
    // them mean not one of them becomes a second row.
    expect(await page.locator('[aria-label*="new_funding_round"]').count()).toBe(before);
  });

  await request.delete(`/api/tables/${tableId}`);
});
