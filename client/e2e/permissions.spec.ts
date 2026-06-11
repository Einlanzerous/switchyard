// Viewer-isolation E2E (Phase 6.6 / SWY-105). Runs as the seeded `viewer-user`
// — a `member` human who is a read-only `viewer` on the TEST project and NOT a
// member of the LOCKED project (see server/scripts/seed-test-fixtures.ts and
// e2e/auth.setup.ts's viewer.json storageState).
//
// Proves the four corners of the isolation story:
//   (a) the viewer sees ONLY their project across tickets / boards / directory,
//   (b) write affordances are absent in the UI (+ a read-only banner explains),
//   (c) direct-URL navigation to a non-member project / ticket 404s,
//   (d) the API rejects their write attempts with 403 (role gate, not scope).

import { test, expect } from "@playwright/test";

// Override the default admin storageState — this whole file is the viewer.
test.use({ storageState: "playwright/.auth/viewer.json" });

test.describe("viewer isolation (6.6)", () => {
  // ─── (a) sees only their project ──────────────────────────────────────────
  test("projects directory shows TEST but never LOCKED", async ({ page }) => {
    await page.goto("/projects");
    await expect(page.getByText(/Test Fixtures/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Locked \(E2E isolation\)/i)).toHaveCount(0);
    await expect(page.getByText(/\bLOCKED\b/)).toHaveCount(0);
  });

  test("tickets list (scoped to TEST) shows TEST tickets, never LOCKED-1", async ({ page }) => {
    await page.goto("/tickets?project=TEST");
    await expect(page.getByText(/^TEST-1$/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/^LOCKED-1$/)).toHaveCount(0);
  });

  test("unscoped tickets list never leaks the locked ticket", async ({ page }) => {
    await page.goto("/tickets");
    await expect(page.getByText(/^TEST-1$/).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/^LOCKED-1$/)).toHaveCount(0);
  });

  // ─── (b) write affordances absent + read-only banner ──────────────────────
  test("tickets list: read-only banner shown, New ticket hidden", async ({ page }) => {
    await page.goto("/tickets?project=TEST");
    await expect(page.getByTestId("readonly-banner")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: /New ticket/i })).toHaveCount(0);
  });

  test("project board: read-only banner shown, New ticket hidden", async ({ page }) => {
    await page.goto("/projects/TEST/board");
    await expect(page.getByTestId("readonly-banner")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: /New ticket/i })).toHaveCount(0);
  });

  test("projects directory: New project hidden for a member", async ({ page }) => {
    await page.goto("/projects");
    await expect(page.getByText(/Test Fixtures/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: /New project/i })).toHaveCount(0);
  });

  test("ticket detail: transition + comment composer absent", async ({ page }) => {
    await page.goto("/tickets/TEST-1");
    // The viewer can read a TEST ticket…
    await expect(page.getByText(/^TEST-1$/).first()).toBeVisible({ timeout: 10_000 });
    // …but every write affordance is gone.
    await expect(page.getByRole("button", { name: /Transition to/i })).toHaveCount(0);
    await expect(page.getByTestId("comments-readonly")).toBeVisible();
    await expect(page.getByPlaceholder(/Write a comment/i)).toHaveCount(0);
  });

  // ─── (c) direct-URL navigation to a non-member resource 404s ──────────────
  test("direct URL to a non-member project board 404s", async ({ page }) => {
    await page.goto("/projects/LOCKED/board");
    await expect(page.getByText(/not found/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/^LOCKED-1$/)).toHaveCount(0);
  });

  test("direct URL to a non-member ticket 404s", async ({ page }) => {
    await page.goto("/tickets/LOCKED-1");
    await expect(page.getByText(/not found/i)).toBeVisible({ timeout: 10_000 });
  });

  // ─── (d) the API rejects viewer writes with 403 ───────────────────────────
  test("API write attempts return 403 on member + non-member projects", async ({ page }) => {
    await page.goto("/");
    const token = await page.evaluate(() => localStorage.getItem("switchyard.token"));
    expect(token).toBeTruthy();
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    // Member project, viewer role → 403 from the project-role gate (the token
    // carries write scope, so this proves the ROLE dimension is enforced).
    const createOnTest = await page.request.post("/v1/tickets", {
      headers,
      data: { project_key: "TEST", type: "task", title: "viewer write attempt" },
    });
    expect(createOnTest.status()).toBe(403);

    // Comment on a readable TEST ticket → 403.
    const commentOnTest = await page.request.post("/v1/tickets/TEST-1/comments", {
      headers,
      data: { body: "viewer comment attempt" },
    });
    expect(commentOnTest.status()).toBe(403);

    // Non-member project → 403 on write (existence isn't hidden once you act on
    // a resource by id; only reads 404).
    const createOnLocked = await page.request.post("/v1/tickets", {
      headers,
      data: { project_key: "LOCKED", type: "task", title: "viewer write attempt" },
    });
    expect(createOnLocked.status()).toBe(403);
  });
});
