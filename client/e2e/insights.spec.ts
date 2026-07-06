// Insights E2E — v4 batch (SWY-149–152). Range control (7D/12W/1Y) with URL
// sync + persistence across Board↔Insights swaps, stacked throughput card
// chrome, Who-did-the-work leaderboard, agent-attributed KPI strip.
//
// Assertions stay at the smoke level (same stance as dashboard.spec.ts):
// widgets mount, labels render, empty states appear with the read-only E2E
// seed (3 tickets, no event history). The force-multiplier math and stacked
// hues need seeded history — covered by server integration tests + manual
// review, not here.

import { test, expect } from "@playwright/test";

test.describe("project insights (SWY-149–152)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/projects/TEST/insights");
  });

  test("range control renders with 12W default and drives the URL + labels", async ({ page }) => {
    const seg = (label: string) => page.getByRole("button", { name: label, exact: true });
    await expect(seg("7D")).toBeVisible();
    await expect(seg("12W")).toBeVisible();
    await expect(seg("1Y")).toBeVisible();

    // Default window: weekly buckets.
    await expect(page.getByText("closed / week").first()).toBeVisible();

    await seg("7D").click();
    await expect(page).toHaveURL(/range=7d/);
    await expect(page.getByText("closed / day").first()).toBeVisible();

    await seg("1Y").click();
    await expect(page).toHaveURL(/range=1y/);
    await expect(page.getByText("closed / week").first()).toBeVisible();
  });

  test("selection survives a Board ↔ Insights tab swap", async ({ page }) => {
    await page.getByRole("button", { name: "7D", exact: true }).click();
    await expect(page).toHaveURL(/range=7d/);

    await page.getByRole("button", { name: "Board", exact: true }).click();
    await expect(page).toHaveURL(/\/projects\/TEST\/board/);
    await page.getByRole("button", { name: "Insights", exact: true }).click();

    await expect(page).toHaveURL(/range=7d/);
    await expect(page.getByText("closed / day").first()).toBeVisible();
  });

  test("throughput card carries the agents/you legend; leaderboard mounts", async ({ page }) => {
    await expect(page.getByText("Throughput").first()).toBeVisible();
    await expect(page.getByText("agents", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("you", { exact: true }).first()).toBeVisible();

    await expect(page.getByText("Who did the work")).toBeVisible();
    // Read-only seed has no closure events → rows or the empty sentinel.
    await expect.poll(
      async () =>
        (await page.getByText(/No closures in this window\./i).count()) > 0
        || (await page.getByText(/Force multiplier/i).count()) > 0,
      { message: "leaderboard mounted neither rows nor empty state", timeout: 10_000 },
    ).toBe(true);

    // Degenerate-math guard: the force multiplier must never render NaN.
    await expect(page.locator("body")).not.toContainText("NaN");
  });

  test("KPI strip renders; charts mount canvases", async ({ page }) => {
    for (const label of ["Open", "In progress", "Closed this week"]) {
      await expect(page.locator(`text=${label}`).first()).toBeVisible();
    }
    await expect.poll(
      async () => await page.locator("canvas").count(),
      { message: "no chart canvases mounted", timeout: 10_000 },
    ).toBeGreaterThan(0);
  });
});
