# Playwright E2E suite

Browser-driven coverage for the switchyard client. Pattern adapted from
`Einlanzerous/legislator-lookup-tool-cc` — chromium + firefox, HTML
reporter, trace on first retry, dev server boot via `bun run dev`.

## Layout

```
client/
├── playwright.config.ts        — projects, webServer, storageState wiring
├── e2e/
│   ├── auth.setup.ts           — runs once; mints a test-user token
│   ├── smoke.spec.ts           — boot + sidebar nav + palette (PR gate)
│   ├── tickets.spec.ts         — filter DSL + saved-view round-trip
│   ├── bulk.spec.ts            — multi-select + BulkActionBar + transition modal
│   ├── board.spec.ts           — columns / cards / drawer (drag deferred)
│   └── dashboard.spec.ts       — KPI render + chart canvases mount
└── playwright/.auth/admin.json — generated; gitignored
```

## Local run

```bash
# 1. Make sure dev DB has the fixtures (idempotent):
DATABASE_URL=postgres://...@localhost:5432/switchyard \
  bun --cwd server run seed:test-e2e

# 2. Set ONE of these env vars in client/.env or your shell:
#    BOOTSTRAP_TOKEN=<admin token>           — mints test-user token via API
#    E2E_TEST_USER_TOKEN=<test-user token>   — uses pre-minted token directly

# 3. Run the suite. Vite dev server auto-boots if 5173 is free.
bun --cwd client run test:e2e             # full suite (chromium + firefox)
bun --cwd client run test:e2e:smoke       # smoke only (chromium, ~30s)
bun --cwd client run test:e2e:ui          # interactive UI mode
```

## CI

Lives in `.github/workflows/e2e.yml`. Self-hosted runner so the
homelab Postgres is reachable. Key secrets:

- `E2E_DATABASE_URL` — points at a separate `switchyard_test` DB on the
  same Postgres instance as dev. Provision once:
  `CREATE DATABASE switchyard_test OWNER switchyard_user;`
- `E2E_BOOTSTRAP_TOKEN` — long-lived admin token on the test DB.
- `E2E_TEST_USER_TOKEN` (optional) — pre-minted test-user token; skips
  the runtime mint flow.

## Conventions

- **Read-only TEST project.** Tests assert on TEST-1/2/3 fixtures. Don't
  mutate them — the suite re-runs against the same rows. Bulk-delete or
  destructive flows must create their own scratch tickets via API first.
- **Per-user state isolation.** All saved views, notifications, and
  preferences live on `test-user`. Switch identity via the `setup`
  project's stored auth state, not via /login.
- **No HMR / dev-warning console errors.** Smoke spec asserts on a
  clean console; if a dev tooling warning sneaks in, whitelist it
  explicitly rather than relax the assertion.
