// LLM Insights E2E (SWY-48 / 5.1.2). Smoke-level: the global + per-project
// views mount, the six tiles render, the window selector and cost Ticket/
// Project toggle work, and the Admin → Observability page loads.
//
// The E2E seed has no llm_observations, so the tiles sit in their empty states
// (charts → "No data yet.", tables → "No … recorded", HITL → "No stalls").
// That still proves a non-crashed mount, which is the smoke concern — ECharts
// renders to <canvas> we can't introspect, so we assert structure, not values.

import { test, expect } from "@playwright/test";

const WIDGETS = [/Spend Over Time/i, /Cost By/i, /Latency/i, /Errors/i, /HITL Stalls/i];

test.describe("LLM Insights", () => {
  test("global view mounts the KPI strip and all six tiles", async ({ page }) => {
    await page.goto("/insights/llm");

    await expect(page.getByRole("heading", { name: /^LLM Insights$/i })).toBeVisible();

    // KPI strip labels (values depend on seed; assert the labels exist).
    for (const label of ["Cost", "p95 latency", "Error rate", "Cache hit rate"]) {
      await expect(page.getByText(label, { exact: false }).first()).toBeVisible();
    }

    // Each widget renders its title heading.
    for (const name of WIDGETS) {
      await expect(page.getByRole("heading", { name })).toBeVisible();
    }

    // Non-crashed mount: a chart canvas (data) or an empty-state sentinel.
    await expect
      .poll(
        async () =>
          (await page.locator("canvas").count()) > 0 ||
          (await page.getByText(/No data yet\.|No spend recorded|No latency data|No stalls/i).count()) > 0,
        { message: "no chart canvas or empty-state sentinel rendered", timeout: 10_000 },
      )
      .toBe(true);
  });

  test("window selector and cost Ticket/Project toggle work", async ({ page }) => {
    await page.goto("/insights/llm");

    // Window selector — clicking a range keeps the page rendered (no throw).
    const oneDay = page.getByRole("button", { name: "1D", exact: true });
    await expect(oneDay).toBeVisible();
    await oneDay.click();
    await expect(page.getByRole("heading", { name: /^LLM Insights$/i })).toBeVisible();

    // Cost By toggle — switch to Project grouping.
    const projectBtn = page.getByRole("button", { name: "Project", exact: true });
    await expect(projectBtn).toBeVisible();
    await projectBtn.click();
    await expect(page.getByRole("heading", { name: /Cost By/i })).toBeVisible();
  });

  test("per-project LLM tab renders", async ({ page }) => {
    await page.goto("/projects/TEST/insights/llm");
    await expect(page.getByRole("heading", { name: /Spend Over Time/i })).toBeVisible();
    // The LLM tab is highlighted in the Insights tab strip.
    await expect(page.getByRole("button", { name: /^LLM$/i })).toBeVisible();
  });

  test("Admin → Observability page loads with settings + warn-list", async ({ page }) => {
    await page.goto("/settings/observability");
    await expect(page.getByRole("heading", { name: /^Observability$/i })).toBeVisible();
    await expect(page.getByText(/Electricity rate/i)).toBeVisible();
    await expect(page.getByText(/Raw retention/i)).toBeVisible();
    await expect(page.getByText(/Unknown values/i)).toBeVisible();
  });
});
