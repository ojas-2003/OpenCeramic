import { expect, test, type Page } from "@playwright/test";

/**
 * The one journey a reviewer takes: load the demo table, run it, and watch every
 * cell reach a terminal state.
 *
 * It asserts the engine's contract rather than the pixels — that nothing is left
 * `idle`, `pending` or `running`, and that the run is priced before it starts.
 */

const TERMINAL = ["done", "failed", "skipped"];
const NON_TERMINAL = ["idle", "pending", "running"];

/** Status chips carry aria-label={status}, so no test-only attributes are needed. */
async function countByStatus(page: Page, statuses: string[]): Promise<number> {
  let total = 0;
  for (const status of statuses) {
    total += await page.locator(`[aria-label="${status}"]`).count();
  }
  return total;
}

test("load the demo table, run it, and every cell reaches a terminal state", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "OpenCeramic" })).toBeVisible();

  // Read the new table's id off the response rather than clicking the first
  // link: the list may hold demo tables from earlier runs, and clicking one of
  // those would test a table that is already enriched.
  const created = page.waitForResponse(
    (r) => r.url().endsWith("/api/demo") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Load demo table" }).click();
  const tableId = (await (await created).json()).table.id as string;

  await test.step("open the table that was just created", async () => {
    await page.goto(`/tables/${tableId}`);
    // Website plus six enrichment columns.
    await expect(page.getByText("← Website").first()).toBeVisible();
    await expect(page.getByText("← Find CEO").first()).toBeVisible();
    // Nothing has run yet.
    expect(await countByStatus(page, TERMINAL)).toBe(0);
  });

  let firstPlanned = 0;

  await test.step("the run is priced before anything is spent", async () => {
    await page.getByRole("button", { name: "Run table" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // "Run 150 cells (0 cached) · est. 425 credits" — the summary line, not the
    // dialog's description, which also contains the word "cells".
    const summary = dialog.getByText(/Run \d+ cells .* est\./);
    await expect(summary).toBeVisible();
    firstPlanned = Number(/Run (\d+) cells/.exec((await summary.textContent()) ?? "")?.[1] ?? 0);
    expect(firstPlanned).toBeGreaterThan(0);

    await dialog.getByRole("button", { name: "Confirm" }).click();
  });

  await test.step("every cell reaches a terminal state", async () => {
    // Poll the grid rather than a fixed wait: a full run is minutes.
    await expect
      .poll(() => countByStatus(page, NON_TERMINAL), {
        timeout: 4 * 60 * 1000,
        intervals: [2000],
        message: "cells still idle, pending or running",
      })
      .toBe(0);

    expect(await countByStatus(page, TERMINAL)).toBeGreaterThan(0);
  });

  await test.step("re-running does not redo work that already succeeded", async () => {
    await page.getByRole("button", { name: "Run table" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const summary = dialog.getByText(/Run \d+ cells .* est\./);
    await expect(summary).toBeVisible();
    const secondPlanned = Number(
      /Run (\d+) cells/.exec((await summary.textContent()) ?? "")?.[1] ?? -1,
    );

    // Cells that finished are left alone. Skipped cells are deliberately
    // re-planned — their inputs may have been fixed since — so this is strictly
    // fewer than the first run, not zero.
    expect(secondPlanned).toBeGreaterThanOrEqual(0);
    expect(secondPlanned).toBeLessThan(firstPlanned);
  });
});
