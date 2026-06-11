// Playwright "setup" project. Runs once before any test and produces the
// storageState files every other project mounts:
//   - playwright/.auth/admin.json  — the seeded `test-user` (instance owner;
//     sees every project). Used by the main suite.
//   - playwright/.auth/viewer.json — the seeded `viewer-user` (member, viewer
//     on TEST only). Used by permissions.spec to prove read-only isolation.
//
// Two paths to bootstrap a token:
//   1. E2E_TEST_USER_TOKEN env is set — used directly for test-user. CI
//      provides a long-lived token here so the main suite doesn't depend on
//      /tokens write access. This is the recommended path. (No equivalent for
//      viewer-user — it's always minted, which needs BOOTSTRAP_TOKEN.)
//   2. Fallback (local-dev / viewer): mint a token via the bootstrap admin
//      token by hitting POST /v1/users/{id}/tokens. Requires BOOTSTRAP_TOKEN.
//
// Either way the token is dropped into localStorage under `switchyard.token` —
// the same key the running app reads in lib/api.ts.

import { test as setup, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const ADMIN_STORAGE = "playwright/.auth/admin.json";
const VIEWER_STORAGE = "playwright/.auth/viewer.json";
const TOKEN_KEY = "switchyard.token";

async function fetchUserId(baseURL: string, adminToken: string, name: string): Promise<string> {
  const res = await fetch(`${baseURL}/v1/users?limit=200`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (!res.ok) {
    throw new Error(`failed to list users: ${res.status} ${await res.text()}`);
  }
  const body = await res.json() as { items: Array<{ id: string; name: string }> };
  const u = body.items.find((x) => x.name === name);
  if (!u) {
    throw new Error(`${name} not found — run \`bun --cwd server run seed:test-e2e\` first`);
  }
  return u.id;
}

// Mint with broad scopes so write rejections come from the PROJECT ROLE gate
// (the thing we're testing for the viewer), not from a token-scope shortfall.
async function mintToken(
  baseURL: string,
  adminToken: string,
  userId: string,
  tokenName: string,
): Promise<string> {
  const res = await fetch(`${baseURL}/v1/users/${userId}/tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: tokenName, scopes: ["admin"] }),
  });
  if (!res.ok) {
    throw new Error(`failed to mint ${tokenName}: ${res.status} ${await res.text()}`);
  }
  const body = await res.json() as { token: string };
  return body.token;
}

// Visit once to register the origin, write the token into localStorage, reload,
// assert an authenticated UI element resolves, then persist the storageState.
async function persistAuth(page: Page, token: string, storagePath: string): Promise<void> {
  await page.goto("/");
  await page.evaluate(([k, v]) => { localStorage.setItem(k, v); }, [TOKEN_KEY, token]);
  await page.reload();
  await expect(page.getByRole("link", { name: /tickets/i })).toBeVisible({ timeout: 10_000 });
  fs.mkdirSync(path.dirname(storagePath), { recursive: true });
  await page.context().storageState({ path: storagePath });
}

setup("authenticate as test-user", async ({ page, baseURL }) => {
  if (!baseURL) throw new Error("baseURL must be configured in playwright.config.ts");

  let token = process.env.E2E_TEST_USER_TOKEN;
  if (!token) {
    const adminToken = process.env.BOOTSTRAP_TOKEN;
    if (!adminToken) {
      throw new Error(
        "Neither E2E_TEST_USER_TOKEN nor BOOTSTRAP_TOKEN is set. Set one before running the suite.",
      );
    }
    const userId = await fetchUserId(baseURL, adminToken, "test-user");
    token = await mintToken(baseURL, adminToken, userId, "playwright-e2e");
  }
  await persistAuth(page, token, ADMIN_STORAGE);
});

setup("authenticate as viewer-user", async ({ page, baseURL }) => {
  if (!baseURL) throw new Error("baseURL must be configured in playwright.config.ts");

  // No env shortcut for the viewer — it's always minted, so a write-capable
  // bootstrap token is required (the same one the main fallback path uses).
  const adminToken = process.env.BOOTSTRAP_TOKEN;
  if (!adminToken) {
    throw new Error("BOOTSTRAP_TOKEN is required to mint the viewer-user token for permissions.spec.");
  }
  const userId = await fetchUserId(baseURL, adminToken, "viewer-user");
  const token = await mintToken(baseURL, adminToken, userId, "playwright-e2e-viewer");
  await persistAuth(page, token, VIEWER_STORAGE);
});
