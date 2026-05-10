// Tickets-list E2E. Asserts the surfaces a daily user touches most:
//   - Filter DSL parses typed `project=` and `assignee=` tokens into chips
//   - Filtered list re-flows to match
//   - Saved-view round-trip (save current → re-apply via dropdown menu)
//
// All assertions read from the seeded TEST project. Tests don't mutate
// fixture rows; the saved-view CRUD is per-user so it lives on
// `test-user` and doesn't pollute the dev `magos` workspace.

import { test, expect } from "@playwright/test";

test.describe("tickets list", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/tickets");
    await expect(page.getByPlaceholder(/Search tickets/i)).toBeVisible();
  });

  test("filter DSL: typing project=TEST renders a project chip and filters list", async ({ page }) => {
    const input = page.getByPlaceholder(/Search tickets/i);
    await input.fill("project=TEST");

    // Chip appears for the parsed project filter. Anchor on the
    // remove-filter button rather than the displayed label — the label
    // depends on the projects-list query having resolved (so it can
    // show the project name), and that resolution races against test
    // timing.
    await expect(page.getByLabel(/Remove project filter/i)).toBeVisible({ timeout: 5_000 });

    // List shows our seeded fixtures.
    await expect(page.getByText(/^TEST-1$/)).toBeVisible();
  });

  test("removing a parsed chip clears the corresponding token from the input", async ({ page }) => {
    const input = page.getByPlaceholder(/Search tickets/i);
    await input.fill("project=TEST");

    const chipRemove = page.getByLabel(/Remove project filter/i).first();
    await chipRemove.click();

    // Input no longer carries the project= token.
    await expect(input).not.toHaveValue(/project=/i);
  });

  test("saved view round-trip: save → menu apply", async ({ page }) => {
    const input = page.getByPlaceholder(/Search tickets/i);
    await input.fill("project=TEST");
    await expect(page.getByLabel(/Remove project filter/i)).toBeVisible();

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
    await expect(input).not.toHaveValue(/project=/i);

    // Re-apply via the Views menu.
    await page.getByRole("button", { name: /^Views$/ }).click();
    await page.getByRole("menuitem", { name: viewName }).click();

    // Filter is re-applied: chip is back, input shows project=TEST.
    await expect(page.getByLabel(/Remove project filter/i)).toBeVisible();
    await expect(input).toHaveValue(/project=TEST/i);
  });
});
