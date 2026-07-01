// Plan-as-PR review UI E2E (SWY-110 / Phase 7.1). Drives the human review
// surface end to end: a scratch ticket + plan are seeded via the REST API (plan
// authoring is the agent's job, not the UI's), then the round-trip
// submit → request changes → revise → approve is exercised through the browser.
//
// Follows the suite convention for destructive flows: it creates its OWN
// throwaway ticket in TEST (never touches the TEST-1/2/3 fixtures) and deletes
// it on teardown, so re-runs stay clean.

import { test, expect, type APIRequestContext } from "@playwright/test";

const TOKEN_KEY = "switchyard.token";

// REST helpers bound to the captured test-user token. Plan authoring + the
// scratch-ticket lifecycle go straight to the API; only the review is UI-driven.
async function api(
  request: APIRequestContext,
  token: string,
  method: "post" | "get" | "delete",
  path: string,
  body?: unknown,
) {
  const res = await request[method](path, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { data: body } : {}),
  });
  if (!res.ok()) throw new Error(`${method.toUpperCase()} ${path} → ${res.status()} ${await res.text()}`);
  return res.status() === 204 ? null : res.json();
}

test.describe("plan review UI", () => {
  test("submit → request changes → revise → approve round-trip", async ({ page, request }) => {
    await page.goto("/");
    const token = await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY);
    if (!token) throw new Error("no auth token in localStorage — setup project did not run");

    // ── seed: scratch ticket + revision 1 (via API) ──────────────────────────
    const ticket = await api(request, token, "post", "/v1/tickets", {
      project_key: "TEST",
      type: "task",
      title: `Plan review E2E ${Date.now()}`,
    });
    const key: string = ticket.key;

    try {
      await api(request, token, "post", `/v1/tickets/${key}/plan/revisions`, {
        narrative_md: "## Approach\nDo the work carefully and incrementally.",
        criteria: [{ text: "Compiles cleanly" }, { text: "Tests pass" }],
      });

      // ── open the Plan tab (deep-linked) ──────────────────────────────────────
      await page.goto(`/tickets/${key}?tab=plan`);
      await expect(page.getByText("Do the work carefully and incrementally.")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("Compiles cleanly")).toBeVisible();
      await expect(page.getByText("Tests pass")).toBeVisible();
      // Header pill (first occurrence; revision history repeats the label).
      await expect(page.getByText("In review").first()).toBeVisible();

      // ── request changes: reject a criterion + leave an overall note ──────────
      await page.getByRole("button", { name: /Reject: Tests pass/i }).click();
      await page.getByPlaceholder(/Overall review note/i).fill("Please tighten the test scope.");
      await page.getByRole("button", { name: /Request changes/i }).click();

      // The plan drops back to a rework state; review actions disappear.
      await expect(page.getByText(/awaiting a new revision from the agent/i)).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("Changes requested").first()).toBeVisible();

      // ── revise (via API): a fresh revision pulls it back into review ─────────
      await api(request, token, "post", `/v1/tickets/${key}/plan/revisions`, {
        narrative_md: "## Approach\nDo the work carefully, with a tighter, faster test suite.",
        criteria: [{ text: "Compiles cleanly" }, { text: "Tests pass quickly" }],
      });

      await page.goto(`/tickets/${key}?tab=plan`);
      await expect(page.getByText("In review").first()).toBeVisible({ timeout: 10_000 });
      // The intent diff against revision 1 is rendered. The revised criterion
      // appears in both the diff (as an "added" row) and the criteria list, so
      // scope to the first match.
      await expect(page.getByText(/Changes since revision 1/i)).toBeVisible();
      await expect(page.getByText("Tests pass quickly").first()).toBeVisible();

      // ── approve → Building ───────────────────────────────────────────────────
      await page.getByRole("button", { name: /Approve all/i }).click();
      await expect(
        page.getByText(/acceptance criteria are now the build's verification contract/i),
      ).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("Approved").first()).toBeVisible();
    } finally {
      // Teardown: soft-delete the scratch ticket so TEST stays clean for re-runs.
      await api(request, token, "delete", `/v1/tickets/${key}`).catch(() => {});
    }
  });
});
