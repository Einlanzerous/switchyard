// Tickets-list E2E. Asserts the surfaces a daily user touches most:
//   - Filter chip + list reflect the URL filter
//   - Typed `project=` DSL eventually populates the URL slot
//   - Removing a chip clears the URL slot
//   - Saved-view round-trip (save current → re-apply via dropdown menu)
//
// Why we mostly navigate directly to /tickets?project=TEST instead of
// typing into the search input: the input has a 250ms debounce + a few
// async router pushes. CI timing makes that flow flaky. The URL→chip
// path is the same code we care about in production, just exercised
// without the input race.
//
// One test still does exercise the typed flow (the DSL parser is
// load-bearing UX), but uses a generous timeout and asserts on the URL
// rather than chip text — the chip's `aria-label` is the stable hook.

import { test, expect } from "@playwright/test";

test.describe("tickets list", () => {
  test("filter chip + list reflect URL-set project filter", async ({ page }) => {
    await page.goto("/tickets?project=TEST");

    // Chip rendered for the URL-driven filter.
    await expect(page.getByLabel(/Remove project filter/i)).toBeVisible({ timeout: 10_000 });

    // List shows our seeded fixtures.
    await expect(page.getByText(/^TEST-1$/)).toBeVisible({ timeout: 10_000 });
  });

  test("filter DSL: typing project=TEST in the search input populates the URL slot", async ({ page }) => {
    await page.goto("/tickets");
    const input = page.getByPlaceholder(/Search tickets/i);
    // pressSequentially fires native input events char-by-char, which
    // works around shadcn Input's `useVModel({ passive: true })` not
    // reacting to .fill()'s programmatic value-set in headless mode.
    // Also blur the input to flush any pending debounce.
    await input.click();
    await input.pressSequentially("project=TEST", { delay: 30 });
    await input.blur();

    // 250ms debounce + router push. Chip's remove-button aria-label is
    // the stable hook.
    await expect(page.getByLabel(/Remove project filter/i)).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(/[?&]project=TEST/);
  });

  test("removing a parsed chip clears the corresponding URL slot", async ({ page }) => {
    await page.goto("/tickets?project=TEST");
    await expect(page.getByLabel(/Remove project filter/i)).toBeVisible({ timeout: 10_000 });

    await page.getByLabel(/Remove project filter/i).first().click();
    await expect(page).not.toHaveURL(/[?&]project=/);
  });

  test("saved view round-trip: save → menu apply", async ({ page }) => {
    await page.goto("/tickets?project=TEST");
    await expect(page.getByLabel(/Remove project filter/i)).toBeVisible({ timeout: 10_000 });

    // Open Views menu, pick "Save current as view…"
    await page.getByRole("button", { name: /^Views$/ }).click();
    await page.getByRole("menuitem", { name: /Save current as view/i }).click();

    // Save dialog: name + scope (default personal) + Save
    const dialog = page.getByRole("dialog", { name: /Save view/i });
    await expect(dialog).toBeVisible();

    const viewName = `e2e ${Date.now()}`;
    await dialog.getByLabel(/^Name$/i).fill(viewName);
    await dialog.getByRole("button", { name: /^Save view$/i }).click();
    await expect(dialog).toBeHidden({ timeout: 5_000 });

    // Clear filters by removing the project chip.
    await page.getByLabel(/Remove project filter/i).first().click();
    await expect(page).not.toHaveURL(/[?&]project=/);

    // Re-apply via the Views menu.
    await page.getByRole("button", { name: /^Views$/ }).click();
    await page.getByRole("menuitem", { name: viewName }).click();

    // Filter is re-applied: chip is back, URL has the filter again.
    await expect(page.getByLabel(/Remove project filter/i)).toBeVisible({ timeout: 5_000 });
    await expect(page).toHaveURL(/[?&]project=TEST/);
  });

  test("due-date filter chips drive URL state", async ({ page }) => {
    await page.goto("/tickets?project=TEST");
    // Click the "Overdue" chip in the Due group.
    await page.getByRole("button", { name: /^Overdue$/ }).click();
    await expect(page).toHaveURL(/[?&]due=overdue/);
    // Click again toggles off (single-select clears when reselected).
    await page.getByRole("button", { name: /^Overdue$/ }).click();
    await expect(page).not.toHaveURL(/[?&]due=/);
    // Switching to "Due this week" replaces, not stacks.
    await page.getByRole("button", { name: /^Overdue$/ }).click();
    await page.getByRole("button", { name: /^Due this week$/ }).click();
    await expect(page).toHaveURL(/[?&]due=this_week/);
    await expect(page).not.toHaveURL(/[?&]due=overdue/);
  });
});
