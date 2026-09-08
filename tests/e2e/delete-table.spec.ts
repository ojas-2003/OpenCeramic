import { expect, test } from "@playwright/test";

/**
 * Deleting a table cascades to its columns, rows and cells. Worth an end-to-end
 * check that the button is reachable, confirms, and that the row disappears.
 */
test("a table can be created and deleted from the UI", async ({ page }) => {
  const name = `E2E delete ${Date.now()}`;

  await page.goto("/");
  await page.getByRole("button", { name: "New table" }).click();

  const nameInput = page.getByPlaceholder("Table name");
  await expect(nameInput).toBeVisible();
  await nameInput.fill(name);

  const created = page.waitForResponse(
    (r) => r.url().endsWith("/api/tables") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create" }).click();
  expect((await created).status()).toBe(201);

  const row = page.getByRole("listitem").filter({ hasText: name });
  await expect(row).toBeVisible();

  // The confirm dialog is a native window.confirm.
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain(name);
    void dialog.accept();
  });
  await row.getByRole("button", { name: `Delete ${name}` }).click();

  await expect(row).toHaveCount(0);
  await expect(page.getByText("Table deleted")).toBeVisible();

  // Gone from the server too, not just the client cache.
  await page.reload();
  await expect(page.getByText(name)).toHaveCount(0);
});
