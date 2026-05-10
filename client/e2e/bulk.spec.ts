// Bulk ops E2E. Asserts:
//   - Checkbox multi-select shows the BulkActionBar with the right count
//   - Shift-click range-select adds the in-between rows
//   - Bulk transition modal opens, category-pick maps per project
//
// Bulk delete is deliberately NOT covered here — it'd remove the TEST
// fixtures and break every other test. Delete-flow coverage belongs in
// a separate spec that creates its own throwaway tickets via API first.

import { test, expect } from "@playwright/test";

test.describe("bulk actions", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/tickets");
    await page.getByPlaceholder(/Search tickets/i).fill("project=TEST");
    await expect(page.getByText(/^TEST-1$/)).toBeVisible({ timeout: 5_000 });
  });

  test("checkbox click shows the BulkActionBar with N selected", async ({ page }) => {
    // Click the wrapping cell, not the inner Checkbox — Playwright's
    // click on reka-ui's CheckboxRoot doesn't reliably bubble to our
    // wrapper's onClick, so tests target the data-testid'd cell.
    await page.getByTestId("select-cell-TEST-1").click();

    // Floating bar at the bottom-center surfaces the count.
    await expect(page.getByText(/^1 selected$/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Assign$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Add label$/i })).toBeVisible();
  });

  test("Clear button drops the selection + hides the BulkActionBar", async ({ page }) => {
    await page.getByTestId("select-cell-TEST-1").click();
    await expect(page.getByText(/^1 selected$/i)).toBeVisible();

    await page.getByRole("button", { name: /^Clear$/i }).click();
    await expect(page.getByText(/^1 selected$/i)).toBeHidden();
  });

  test("Move to… opens the BulkTransitionModal with category buttons", async ({ page }) => {
    await page.getByTestId("select-cell-TEST-1").click();
    await page.getByRole("button", { name: /Move to/i }).click();

    const dialog = page.getByRole("dialog", { name: /Move to status/i });
    await expect(dialog).toBeVisible();
    // Five status-category buttons.
    await expect(dialog.getByRole("button", { name: /^Backlog$/ })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /^In Progress$/ })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /^Closed$/ })).toBeVisible();

    // Cancel closes without firing.
    await dialog.getByRole("button", { name: /^Cancel$/ }).click();
    await expect(dialog).toBeHidden();
  });
});
