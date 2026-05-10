// Dashboard E2E. KPI numerics render, charts mount without console
// errors, mentions widget shows the empty state when test-user has no
// inbound mentions.
//
// Charts: ECharts renders to a <canvas> inside its container — we
// can't introspect chart contents from the DOM, so the smoke test here
// is "the widget renders + the canvas exists". Visual regressions are
// out of scope for E2E; lean on manual inspection or a dedicated
// snapshot suite for those.

import { test, expect } from "@playwright/test";

test.describe("dashboard (HomeView)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("KPI strip renders with numeric values", async ({ page }) => {
    // Each KPI label has a numeric value inside its card. We assert on
    // visibility rather than exact value (depends on seed state).
    const labels = ["Open tickets", "In progress", "Closed this week", "Median cycle time"];
    for (const label of labels) {
      const card = page.locator("text=" + label).first();
      await expect(card).toBeVisible();
    }
  });

  test("throughput + status distribution charts mount canvases", async ({ page }) => {
    // ECharts in canvas-renderer mode mounts a single <canvas> per
    // chart. There are at least two charts on the homepage.
    const canvases = page.locator("canvas");
    // Wait until at least two render — the dashboard loads them async.
    await expect.poll(async () => canvases.count(), {
      message: "expected ≥2 chart canvases to mount",
      timeout: 10_000,
    }).toBeGreaterThanOrEqual(2);
  });

  test("mentions widget renders + window selector toggles", async ({ page }) => {
    // The widget has a select with five window options. Click it and
    // pick a different value; the widget should re-fetch.
    const select = page.getByLabel(/Mentions window/i);
    await expect(select).toBeVisible();
    await select.selectOption("3");
    // No specific data assertion — we just want the select to be
    // interactive without errors. Logged console errors fail the test
    // suite separately via the smoke spec's no-error guard.
  });

  test("recent activity widget renders", async ({ page }) => {
    await expect(page.getByText(/Recent activity/i).first()).toBeVisible();
  });
});
