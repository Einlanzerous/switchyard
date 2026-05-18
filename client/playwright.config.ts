// Playwright config for switchyard's E2E suite.
//
// Pattern adapted from Einlanzerous/legislator-lookup-tool-cc — chromium +
// firefox projects, html reporter, trace on first retry, dev server boot
// via the workspace's `bun run dev`.
//
// Sub-suites:
//   smoke.spec.ts    — chromium-only fast path; gates PRs
//   tickets/board/bulk/dashboard.spec.ts — full coverage; runs in CI
//
// Auth: handled by the `setup` project which exchanges the bootstrap
// token for a real per-user token, persists it to localStorage, then
// every subsequent test imports that storageState. See e2e/auth.setup.ts.

import { defineConfig, devices } from "@playwright/test";

// E2E runs Vite on a port distinct from local dev (:5173) so the suite can
// be kicked while a developer still has `bun run dev:client` up on the
// self-hosted runner. Override via E2E_VITE_PORT if needed.
const VITE_PORT = process.env.E2E_VITE_PORT ?? "5273";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["html"], ["github"]] : "html",
  // Default test timeout. Tests that interact with virtualized lists or
  // charts may need longer locally — bump per-test if needed.
  timeout: 30_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${VITE_PORT}`,
    trace: "on-first-retry",
    // Allow tests to run against an already-running dev server (CI), but
    // also boot one if invoked locally without a server up. See webServer
    // below — `reuseExistingServer` is the toggle.
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
  },
  projects: [
    // Auth state lives in playwright/.auth/admin.json. The `setup`
    // project produces it; every other project depends on `setup` and
    // mounts the resulting storageState.
    {
      name: "setup",
      testMatch: /auth\.setup\.ts$/,
    },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "playwright/.auth/admin.json",
      },
      dependencies: ["setup"],
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        storageState: "playwright/.auth/admin.json",
      },
      dependencies: ["setup"],
    },
  ],
  webServer: {
    // `bun --cwd` works when invoked from the client/ directory; the
    // command is run from where `playwright test` was executed (we run
    // from client/, so `bun run dev` resolves to the workspace's dev
    // script). Pass --port through so Vite binds to our chosen E2E port
    // instead of the default :5173 (which dev may have).
    command: `bun run dev -- --port ${VITE_PORT} --strictPort`,
    url: `http://localhost:${VITE_PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
