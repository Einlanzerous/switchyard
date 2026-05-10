// Playwright "setup" project. Runs once before any test, mints (or
// reuses) a token for the seeded `test-user` account, persists the
// resulting auth state to disk, and every other project mounts that
// state via `storageState: "playwright/.auth/admin.json"`.
//
// Two paths to bootstrap:
//   1. E2E_TEST_USER_TOKEN env is set — we use it directly. CI provides
//      a long-lived token here so tests don't depend on /tokens write
//      access. This is the recommended path.
//   2. Fallback (local-dev): we mint a token via the bootstrap admin
//      token by hitting POST /v1/users/{id}/tokens. Requires
//      BOOTSTRAP_TOKEN to be set with admin scope.
//
// Either way the resulting token is dropped into localStorage under the
// `switchyard.token` key — the same key the running app reads in
// lib/api.ts.

import { test as setup, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const STORAGE_PATH = "playwright/.auth/admin.json";
const TOKEN_KEY = "switchyard.token";

async function fetchTestUserId(baseURL: string, adminToken: string): Promise<string> {
  const res = await fetch(`${baseURL}/v1/users?limit=200`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (!res.ok) {
    throw new Error(`failed to list users: ${res.status} ${await res.text()}`);
  }
  const body = await res.json() as { items: Array<{ id: string; name: string }> };
  const u = body.items.find((x) => x.name === "test-user");
  if (!u) {
    throw new Error(
      "test-user not found — run `bun --cwd server run seed:test-e2e` first"
    );
  }
  return u.id;
}

async function mintTokenForTestUser(baseURL: string, adminToken: string): Promise<string> {
  const userId = await fetchTestUserId(baseURL, adminToken);
  const res = await fetch(`${baseURL}/v1/users/${userId}/tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "playwright-e2e",
      // Test-user needs every scope our test flows touch. Mint with
      // admin so the suite can hit any endpoint without per-test scope
      // surgery.
      scopes: ["admin"],
    }),
  });
  if (!res.ok) {
    throw new Error(`failed to mint test-user token: ${res.status} ${await res.text()}`);
  }
  const body = await res.json() as { token: string };
  return body.token;
}

setup("authenticate as test-user", async ({ page, baseURL }) => {
  if (!baseURL) throw new Error("baseURL must be configured in playwright.config.ts");

  // Prefer the explicit env-provided token (CI / cached path).
  let token = process.env.E2E_TEST_USER_TOKEN;
  if (!token) {
    const adminToken = process.env.BOOTSTRAP_TOKEN;
    if (!adminToken) {
      throw new Error(
        "Neither E2E_TEST_USER_TOKEN nor BOOTSTRAP_TOKEN is set. "
        + "Set one before running the suite."
      );
    }
    token = await mintTokenForTestUser(baseURL, adminToken);
  }

  // Visit the app once so the origin is registered for storageState,
  // then write the token into localStorage. We avoid the login form
  // entirely — the form only exists for new users; programmatic auth
  // matches what a returning user with a stored token does.
  await page.goto("/");
  await page.evaluate(([k, v]) => { localStorage.setItem(k, v); }, [TOKEN_KEY, token]);

  // Verify the token works by reloading + asserting on a known
  // authenticated UI element. A failure here means the token is bogus
  // and every downstream test would otherwise time out.
  await page.reload();
  await expect(page.getByRole("link", { name: /tickets/i })).toBeVisible({ timeout: 10_000 });

  fs.mkdirSync(path.dirname(STORAGE_PATH), { recursive: true });
  await page.context().storageState({ path: STORAGE_PATH });
});
