// Dashboard E2E — v4 "Elevated" layout (SWY-140–143). Greeting narrative,
// work-centric KPI strip, Active-projects / Epics-in-flight cards, enriched
// activity feed + Up-next.
//
// Assertions stay at the smoke level: widgets mount, labels render, empty
// states appear with the read-only E2E seed (3 tickets, no event history).
// Visual regressions are out of scope for E2E; lean on manual inspection
// or a dedicated snapshot suite for those.

import { test, expect } from "@playwright/test";

test.describe("dashboard (HomeView)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("greeting renders time-of-day + New ticket button", async ({ page }) => {
    await expect(
      page.getByRole("heading", { name: /^Good (morning|afternoon|evening)/ }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /new ticket/i })).toBeVisible();
  });

  test("KPI strip renders the four work-centric cards", async ({ page }) => {
    // Assert on label visibility rather than exact values (depends on seed
    // state). "Needs you" is the accent card fed by the stalled-epics
    // interim source until SWY-139 lands.
    const labels = ["Epics in flight", "Closed · 7d", "Agent share", "Needs you"];
    for (const label of labels) {
      await expect(page.locator(`text=${label}`).first()).toBeVisible();
    }
  });

  test("active projects + epics in flight cards render", async ({ page }) => {
    await expect(page.getByRole("heading", { name: /active projects/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /epics in flight/i })).toBeVisible();
    // With the E2E seed either rows or the styled empty states must mount.
    await expect.poll(
      async () =>
        (await page.getByText(/No projects yet\./i).count()) > 0
        || (await page.locator("svg polyline").count()) > 0,
      { message: "active-projects card mounted neither rows nor empty state", timeout: 10_000 },
    ).toBe(true);
    await expect.poll(
      async () =>
        (await page.getByText(/No epics in flight\./i).count()) > 0
        || (await page.getByText(/%|stalled|plan|done/).count()) > 0,
      { message: "epics card mounted neither rows nor empty state", timeout: 10_000 },
    ).toBe(true);
  });

  test("recent activity + up next render", async ({ page }) => {
    await expect(page.getByText(/Recent activity/i).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /up next/i })).toBeVisible();
    // Up-next shows either backlog rows or its empty sentinel.
    await expect.poll(
      async () =>
        (await page.getByText(/Backlog is clear\./i).count()) > 0
        || (await page.locator("ul li").count()) > 0,
      { message: "up-next card mounted neither rows nor empty state", timeout: 10_000 },
    ).toBe(true);
  });

  test("v3 vanity widgets are no longer on the dashboard", async ({ page }) => {
    // Throughput/status-donut moved to Insights; stale rollup was
    // superseded by the Needs-you KPI; per-user widgets stay off the
    // dashboard (profile menu + notification bell). Guard regressions.
    await expect(page.getByRole("heading", { name: /throughput/i })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /status distribution/i })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /stale work/i })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /my open tickets/i })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /^mentions$/i })).toHaveCount(0);
  });
});
