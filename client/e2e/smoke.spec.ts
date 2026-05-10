// Smoke tests — the PR gate. Target <30s runtime, chromium only via
// `bun run test:e2e:smoke`. Asserts: app boots without console errors,
// every top-level sidebar nav route renders a known anchor element, and
// the command palette opens.
//
// New routes get one assertion here. If a smoke check fails, the build
// is broken and downstream feature suites won't be meaningful — this is
// the canary.

import { test, expect } from "@playwright/test";

test.describe("smoke", () => {
  test("app boots without console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await page.goto("/");
    await expect(page.getByRole("link", { name: /tickets/i })).toBeVisible();
    expect(errors, "no console errors on boot").toEqual([]);
  });

  test("home renders the dashboard", async ({ page }) => {
    await page.goto("/");
    // KPI strip is the most reliable home-page anchor — present whenever
    // /v1/stats/projects responds.
    await expect(page.getByText(/Open tickets/i).first()).toBeVisible();
    await expect(page.getByText(/In progress/i).first()).toBeVisible();
  });

  test("tickets list renders", async ({ page }) => {
    await page.goto("/tickets");
    // FilterBar's search input is the structural anchor.
    await expect(page.getByPlaceholder(/Search tickets/i)).toBeVisible();
  });

  test("boards list renders", async ({ page }) => {
    await page.goto("/boards");
    // Either an existing board or the "New board" empty CTA.
    await expect(page.getByRole("button", { name: /new board/i })).toBeVisible();
  });

  test("projects directory renders", async ({ page }) => {
    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: /^Projects$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /new project/i })).toBeVisible();
  });

  test("automations renders", async ({ page }) => {
    await page.goto("/automations");
    // Default redirect is /automations/webhooks; assert on the "New webhook" CTA
    // (visible whether or not webhooks exist — empty state and populated state
    // both surface it).
    await expect(page.getByRole("button", { name: /new webhook/i })).toBeVisible();
  });

  test("settings renders", async ({ page }) => {
    await page.goto("/settings");
    // Default redirect is /settings/profile.
    await expect(page.getByRole("heading", { name: /^Profile$/i })).toBeVisible();
  });

  test("health page renders", async ({ page }) => {
    await page.goto("/health");
    await expect(page.getByRole("heading", { name: /^Health$/i })).toBeVisible();
  });

  test("command palette opens via Ctrl+K", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Control+k");
    // The CommandDialog renders a search input as soon as it opens.
    await expect(page.getByPlaceholder(/Search tickets, projects, boards/i)).toBeVisible();
  });
});
