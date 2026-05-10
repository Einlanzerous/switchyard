// Bulk ops E2E. Asserts:
//   - Checkbox multi-select shows the BulkActionBar with the right count
//   - Bulk transition modal opens and surfaces the category mapping
//
// Bulk delete is deliberately NOT covered here — it'd remove the TEST
// fixtures and break every other test. Delete-flow coverage belongs in
// a separate spec that creates its own throwaway tickets via API first.
//
// Tests navigate directly to /tickets?project=TEST rather than typing
// the filter into the search input — the typed flow has a 250ms debounce
// + several async router pushes that make CI flaky, and the URL-driven
// path is the same code we care about in production.

import { test, expect, type Page } from "@playwright/test";

test.describe("bulk actions", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/tickets?project=TEST");
    await expect(page.getByText(/^TEST-1$/)).toBeVisible({ timeout: 10_000 });
  });

  // Scope assertions to the bulk-actions toolbar so we don't collide
  // with the FilterBar's "Clear filters" button (which has the same
  // visible text), and so the count text isn't matched as anchored —
  // Vue's template renders `{{ count }} selected` with surrounding
  // whitespace, so a non-anchored substring inside the toolbar is the
  // most stable signal.
  function bar(page: Page) {
    return page.getByRole("toolbar", { name: /bulk actions/i });
  }

  test("checkbox click shows the BulkActionBar with N selected", async ({ page }) => {
    // Click the wrapping cell, not the inner Checkbox — Playwright's
    // click on reka-ui's CheckboxRoot doesn't reliably bubble to our
    // wrapper's onClick, so tests target the data-testid'd cell.
    await page.getByTestId("select-cell-TEST-1").click();

    await expect(bar(page)).toBeVisible({ timeout: 5_000 });
    await expect(bar(page).getByText(/1 selected/i)).toBeVisible();
    await expect(bar(page).getByRole("button", { name: /^Assign$/i })).toBeVisible();
    await expect(bar(page).getByRole("button", { name: /^Add label$/i })).toBeVisible();
  });

  test("Clear button drops the selection + hides the BulkActionBar", async ({ page }) => {
    await page.getByTestId("select-cell-TEST-1").click();
    await expect(bar(page)).toBeVisible({ timeout: 5_000 });

    // Important: scope to the toolbar — there's also a "Clear" button
    // in the FilterBar (the Clear-all-filters one).
    await bar(page).getByRole("button", { name: /^Clear$/ }).click();
    await expect(bar(page)).toBeHidden();
  });

  test("Move to… opens the BulkTransitionModal with category buttons", async ({ page }) => {
    await page.getByTestId("select-cell-TEST-1").click();
    await expect(bar(page)).toBeVisible({ timeout: 5_000 });

    await bar(page).getByRole("button", { name: /Move to/i }).click();

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
