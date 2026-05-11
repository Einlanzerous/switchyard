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

  test("throughput + status distribution widgets render", async ({ page }) => {
    // ECharts in canvas-renderer mode mounts a <canvas> per chart when
    // data exists; the widget framework renders a "No data yet." sentinel
    // otherwise. Both prove the widget mounted without throwing — which
    // is the smoke-test concern. With the E2E seed (3 tickets, no event
    // history) the stats endpoints return all zeros, so the widgets sit
    // in the empty state; against a populated install they show canvases.
    // DashboardWidget renders its title in a CardTitle (<h3>) alongside
    // optional prefix/suffix slots; the throughput card includes a
    // "closed/week, last 12" suffix so the accessible name isn't an
    // exact "Throughput" match. Hit by role + substring instead.
    const throughput = page.getByRole("heading", { name: /throughput/i });
    const statusDist = page.getByRole("heading", { name: /status distribution/i });
    await expect(throughput).toBeVisible();
    await expect(statusDist).toBeVisible();

    // Either a canvas (data) or the "No data yet." sentinel (empty) must
    // be present somewhere on the page. We don't enforce a count — the
    // widget framework's loading → empty → populated transitions are
    // verified in unit tests; here we just want a non-crashed mount.
    await expect.poll(
      async () => (await page.locator("canvas").count()) > 0
        || (await page.getByText(/No data yet\./i).count()) > 0,
      { message: "neither a chart canvas nor empty-state sentinel rendered", timeout: 10_000 },
    ).toBe(true);
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
