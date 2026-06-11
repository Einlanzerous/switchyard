# switchyard — phased build plan

Living document. Updated as decisions land.

## Phase 0 — Contract & scaffold ✅

**Shipped.** Establishes the API surface, schema, container shape, and integration story without any business logic.

- Drizzle schema for 16 tables (`server/drizzle/schema.ts`) + triggers (`triggers.sql`) for epic hierarchy, resolution-on-close, and updated_at auto-bump.
- Zod schemas for every resource (`shared/src/schemas/*.ts`) — single source of truth.
- ~50 routes defined with `@hono/zod-openapi` (`server/src/routes/*.ts`); all handlers stubbed to 501.
- Hono entry with health, OpenAPI doc at `/v1/openapi.json`, static client serving.
- Multi-stage Dockerfile, single-container deploy.
- Compose / env / init-db diffs for `~/construct-server` (`compose-changes/README.md`).
- Vue 3 + Vite + Tailwind + shadcn-vue scaffold; placeholder home view that pings `/healthz`.

## Phase 1 — Backend MVP ✅

**Shipped.** All 7 milestones (1.0–1.6) plus a correctness/DRY closeout pass. The imperium-loop migration off Vikunja completed against this API surface on 2026-05-14 (see "Imperium-loop migration" section at the bottom).

### Locked decisions for Phase 1

- **Webhook dispatcher:** in-process polling loop with `FOR UPDATE SKIP LOCKED`. Survives missed notifications without a permanent connection.
- **Test database:** approach (a) — `switchyard_test` DB on construct's existing Postgres, devs pass `DATABASE_URL_TEST`. Cheaper than spinning up an ephemeral container.
- **Attachment size caps (configurable via env):** image 25MB, audio 100MB, text 5MB. Adjustable via `ATTACHMENT_MAX_*_BYTES` env vars.
- **Default project status seed: 5 statuses** — Backlog, Planning, In Progress, Blocked, Closed. Planning is included because it's a first-class enum value; projects that don't use it can delete their Planning status.
- **Bootstrap token UX:** explicit `BOOTSTRAP_TOKEN` env wins. If unset and `api_tokens` is empty on boot, auto-generate one and log it once with a clear delimiter; also write it to `${UPLOAD_DIR}/.bootstrap-token` for one-shot retrieval.
- **TS client codegen:** `client/src/lib/api.types.ts` is generated from `openapi.yaml` and **committed** for diff visibility on PRs. Regenerated explicitly via a script, not at build time.

### Milestone 1.0 — Foundations ✅

All cross-cutting infrastructure handlers use; tests; no business endpoints yet.

- Initial Drizzle migration committed at `server/drizzle/migrations/`.
- `migrate.ts` runs migrations → `triggers.sql` → `seed.ts`.
- `seed.ts` — 6 canonical users (`magos`, `claude`, `n8n-cogitation`, `n8n-vox-dictate`, `servo-signal`, `autosavant-bot`) + bootstrap token (env wins, else auto-generate to stdout banner + `${UPLOAD_DIR}/.bootstrap-token`).
- `lib/pagination.ts` — opaque base64url `(updated_at, id)` cursor codec + `cursorWhere` / `cursorOrderBy` / `buildPage` helpers.
- `lib/idempotency.ts` — middleware keyed on `(user, method, path, key)`, 24h TTL, lazy expiration on lookup, hourly cleanup.
- `lib/events.ts` — `writeEvent(tx, …)` writes `events` row AND enqueues matching webhook deliveries in the same transaction.
- `lib/webhooks/dispatcher.ts` — single in-process polling loop, claims via `FOR UPDATE SKIP LOCKED`, HMAC signing, backoff `[1, 4, 16, 64, 256]s`, abandons after `WEBHOOK_MAX_ATTEMPTS`, graceful drain.
- `lib/hmac.ts` — sign + constant-time verify.
- Test harness: `bun run db:test:setup` (applies schema to `switchyard_test`), transaction-rollback per-test, sample tests for pagination + hmac (15 unit tests passing).

### Milestone 1.1 — Read-only API ✅

`lib/mappers.ts` (row → API shape) and `lib/lookups.ts` (id/key resolvers) + every GET handler implemented:

- `users`, `users/me`, `users/{id}`, `users/{id}/tokens`
- `projects`, `projects/{key}`, `projects/{key}/statuses|labels|transitions`
- `tickets` (full filter set: project, status [id or category], type, label, assignee/`unassigned`, reporter, parent, text, updated_after/before, include_deleted; cursor pagination)
- `tickets/{idOrKey}` (full detail: embedded comments with their attachments + ticket attachments + `all_attachments` flattened)
- `tickets/{idOrKey}/events|children|comments`
- `events` (global feed with project / ticket_id / actor_id / event_type / since / until)
- `boards`, `boards/{id}`, `boards/{id}/columns`
- `attachments/{id}/meta`
- `dev:seed-sample` script for populating realistic data on dev DB.

### Milestone 1.2 — Project / admin mutations ✅

- Idempotency middleware wired on every mutation path (after `requireAuth`).
- New `projects:manage` scope; project lifecycle events (`project.created/.updated/.deleted`).
- Users: create/update/soft-delete; token mint (returns secret ONCE) / revoke.
- Projects: create runs in a single txn (project + `project_counters` + 5 default statuses + event); update rejects key changes + supports `archived` flag; soft-delete with event.
- Statuses: create with auto-position; `is_default` flips uniqueness in txn; delete refuses if default or referenced; reorder uses two-pass scratch positions to avoid name-uniqueness collisions mid-update.
- Labels: full CRUD; `ticket_labels` cascade on delete.
- Transitions: create validates both statuses belong to project; from is nullable wildcard; delete by id.
- Pattern shift: scope checks moved from middleware-in-handler-chain to in-handler `checkScope(c, …)` for cleaner type inference.

### Milestone 1.3 — Tickets + comments + attachments ✅

`lib/tickets.ts` shared helpers: `loadTicketSummary` / `loadTicketDetail` / `allocateTicketNumber`. `UpdateTicket` schema tightened to omit `status_id` — status changes go exclusively through `/transition`.

- POST: txn allocates a per-project number, validates parent (epic+same project) / assignee / labels, resolves default status, inserts ticket + labels, emits `ticket.created`.
- PATCH: partial update of title/description/priority/parent/assignee/due/labels/metadata. Emits `ticket.updated` with field-level diff and `ticket.assigned` when assignee changes.
- DELETE: soft delete + `ticket.deleted`.
- /transition: enforces transitions table (zero rows = wildcard, any rows = whitelist with NULL-from), resolution required iff target is closed, epic-close guard (rejects 422 with list of non-closed children), optional atomic comment, multi-event emission (`ticket.status_changed` always; `ticket.closed` when entering closed; `ticket.released` when resolution=`released`).
- Comments: POST/PATCH/DELETE with events.
- Attachments: `lib/attachments.ts` with magic-byte sniffer (PNG / JPEG / GIF / WebP / WAV / MP3+ID3 / OGG / FLAC / M4A) + UTF-8 fallback for text. Multipart upload, per-kind size cap, path-traversal guard. Token-guarded streamed download. DELETE removes row + best-effort file unlink.

### Milestone 1.4 — Webhooks ✅

- POST mints HMAC secret (returned ONCE in `WebhookSubscriptionWithSecret`); subsequent reads exclude it.
- PATCH (partial), DELETE, GET (single + paginated list).
- `/v1/webhooks/{id}/deliveries` paginated delivery log; `/v1/webhooks/deliveries/{id}/redeliver` resets to pending.
- Integration test (`test/integration/webhooks.test.ts`) — spins up `Bun.serve` mock receiver, subscribes, emits an event via `writeEvent`, asserts `Content-Type` / `X-Switchyard-Event` / `X-Switchyard-Signature` headers, verifies HMAC against body, confirms delivery row reaches `succeeded`.

### Milestone 1.5 — Board mutations ✅

- POST: validates `project_ids` non-empty + every id maps to a live project; txn inserts board + `board_projects` rows.
- PATCH: partial of name/layout/filter; project replacement is `delete + reinsert` inside one txn so columns don't briefly flicker through ghost projects.
- DELETE: hard delete; `board_projects` cascade.
- `assertProjectsExist` returns 400 listing the offending ids so agents can fix bad input.

### Milestone 1.6 — Polish + ops ✅

- `/healthz` deepens to subsystem report `{ status, subsystems: { db (with latency), uploads (writability probe), webhooks (queue_depth + warn flag at 1000) } }`. 503 if any required subsystem is degraded.
- Structured JSON access logs via `lib/access-log.ts` (one line per request: ts, request_id, method, path, status, duration_ms, user_id, token_id). Echoes `X-Request-ID` header. Quiet on `/healthz` and `/v1/openapi.json`.
- Graceful shutdown unified under one 10s deadline ceiling: stop accepting connections → drain dispatcher → close DB.
- `client/src/lib/api.ts` is now a real `openapi-fetch` client with a token-injecting middleware. `bun run api:gen` regenerates `client/src/lib/api.types.ts` (committed).
- README "How agents use this API": auth, idempotency, cursor pagination, error envelope, webhook HMAC verification (Node.js + Python), PATCH-vs-/transition rule, filter syntax, request IDs.

### Phase 1 closeout — correctness + DRY pass ✅

- **Two-phase event emission removed.** Mutations and their `writeEvent` calls now share a single transaction in `tickets.ts` and `comments.ts`. `loadTicketSummary` accepts an optional `tx` so reads inside the txn see in-flight writes (e.g. labels just inserted). Failed event writes now roll back the mutation rather than committing a ticket-without-audit-trail.
- **`catchUnique(message, fn)` helper** in `errors.ts` collapses 8 try/catch sites with `if (err?.code === "23505") throw conflict(…)` boilerplate (across users, projects, statuses, transitions, labels).
- **Unused-import cleanup** — all `void <unused>;` markers and the imports they suppressed removed across `users.ts`, `projects.ts`, `statuses.ts`, `comments.ts`, `events.ts`, `tickets.ts`.
- **Deliberately not refactored:** cursor-pagination glue (per-handler shapes vary too much), partial-`sets` builders (loses type safety from `Partial<typeof X.$inferInsert>`), `(async (c: any) => {...}) as any` handler wrappers (purely cosmetic).

Out of scope (deferred to later phases):
- UI (Phase 2)
- Charts / dashboards (Phase 3)
- Native automation rules (Phase 4)

## Phase 2 — Frontend ✅

**Shipped.** All 8 milestones (2.0–2.7). The user can do everything via the UI that they'd otherwise do via curl. Linear-density + ClickUp/Monday color richness; skeleton loaders; drawer ticket detail with deep-linkable URLs.

### Locked decisions for Phase 2

- **Markdown:** `markdown-it` with GFM tables / task lists. Code highlighting deferred (raw `<pre>` is fine for v1).
- **Drag-and-drop:** `pragmatic-drag-and-drop` (Atlassian's; framework-agnostic + keyboard-accessible). The Linear lib.
- **Dates:** `date-fns` (`formatDistanceToNow` for relative, `format` for absolute).
- **Toasts:** `Sonner` via shadcn-vue.
- **Forms:** `vee-validate` + `@vee-validate/zod` so Zod schemas from `@switchyard/shared` drive client-side validation too.
- **Routing:** explicit `router.ts` (project too small for file-based routing to earn its complexity).
- **Filter UI:** chips for small enums (status category, type, priority); combobox for wide ones (label, assignee, project on cross-project boards).
- **Ticket detail:** right-side drawer (Sheet) with deep-linkable URL — `/tickets?focus=SWY-47` keeps the list rendered behind the drawer.
- **Empty / loading:** skeleton loaders everywhere; no spinners.

### Milestone 2.0 — Foundations ✅

- Materialize `client/src/lib/api.types.ts` via `bun run api:gen`.
- Install shadcn-vue components for the shell (button, input, label, card, avatar, dropdown-menu, separator, scroll-area, sonner, sheet, skeleton).
- Add deps: `markdown-it`, `date-fns`, `vee-validate`, `@vee-validate/zod`, `@atlaskit/pragmatic-drag-and-drop` family (deferred to 2.4 if not needed yet).
- Layout shell: sidebar (projects + nav) + topbar (user menu, theme toggle) + main content slot. Empty placeholders inside.
- Pinia stores: `useThemeStore` (light/dark via `@vueuse/core` `useColorMode`), placeholder `useAuthStore`.
- TanStack Query setup: client config, key conventions (`['users','me']`, `['projects']`, `['tickets', filters]`, `['ticket', idOrKey]`, `['boards']`, `['board', id, 'columns']`).
- Top-level error boundary that surfaces API error envelopes via Sonner.

### Milestone 2.1 — Auth flow ✅

- `/login` view: token textarea, validates against `GET /v1/users/me`. On success, stores in localStorage (already wired by the `api.ts` middleware) and redirects to `/`.
- `useAuthStore` derives the logged-in user from `useQuery(['users','me'])`.
- Route guard: redirect unauthenticated to `/login`. Logout clears storage and invalidates queries.
- Topbar shows the user's avatar + dropdown (theme toggle, settings, logout).

### Milestone 2.2 — Tickets list ✅

- `/tickets` route. URL drives filter state (`?project=FLOW&status=in_progress`).
- Filter bar: chips for status-category / type / priority; comboboxes for project / label / assignee; text search (debounced 250ms).
- Virtualized table (TanStack Virtual) with columns: key, type icon, title, status pill, priority, assignee avatar, label badges, updated relative.
- Cursor pagination via `useInfiniteQuery`; "Load more" sentinel triggers `fetchNextPage`.
- Click row → drawer opens with ticket detail (2.3) and `?focus=KEY-N` query param appended.

### Milestone 2.3 — Ticket detail (drawer + page) ✅

- Right-side `Sheet` drawer with tabs: Description / Comments / Files / Activity.
- Description: markdown render via markdown-it with DOMPurify; edit via inline textarea + save.
- Comments: list with author avatar + relative timestamp; markdown body; composer at bottom with file-drop zone (uploads via the multipart endpoint).
- Files: ticket attachments + comment attachments grouped, with download links and (for audio) transcript display.
- Activity: events list with field-level diff rendering for `ticket.updated`, status pill transitions for `ticket.status_changed`, etc.
- Header actions: status transition button (opens menu of allowed transitions; presents resolution selector when target is closed); priority dropdown; assignee picker.
- Standalone `/tickets/:idOrKey` route renders the same drawer over a blank background for direct deep-link access.

### Milestone 2.4 — Kanban board (single-project) ✅

- `/projects/:key/board` route.
- Columns by canonical category (Backlog / Planning / In Progress / Blocked / Closed). Display-name aliases shown in column header.
- Card: ticket key (monospace), title, type icon, assignee avatar, priority pill, label dots.
- pragmatic-drag-and-drop: drag → `POST /v1/tickets/{id}/transition`. On drop into closed column, prompt for resolution. Optimistic update with rollback on error.
- Per-column virtualization for projects with hundreds of tickets in one column.

### Milestone 2.5 — Cross-project boards + swimlanes ✅

- `/boards` list + `/boards/new` (multi-project select via combobox).
- `/boards/:id` view: kanban with optional **swimlanes** (group rows by project / assignee / epic / type).
- Swimlane picker in the board header; persisted in board.filter or local user prefs.
- Saved filters per board (types, priorities, label_ids, assignee_ids).
- Cross-project drag is allowed when target column resolves to a status the receiving project actually has; otherwise rejected with a toast.

### Milestone 2.6 — Settings ✅

- `/settings/profile` — me, avatar (URL field for now), display name.
- `/settings/tokens` — list / create / revoke own tokens.
- `/settings/users` (admin) — user CRUD.
- `/settings/projects` — list / create. Per-project sub-pages: statuses (with reorder + is_default toggle), transitions (graph editor lite), members (skipped if multi-user not enabled yet).
- `/settings/labels` — global label catalog (a single shared list across all projects). CRUD with name + color picker.
- `/settings/webhooks` — subscriptions + delivery log. Redeliver button on failed deliveries. Show secret on creation banner.

### Milestone 2.7 — Polish ✅

- Command palette (Ctrl+K): jump to ticket by key, quick-create ticket, switch project, recent boards.
- Keyboard shortcuts: `g t` → tickets, `g b` → boards, `c` → new ticket, `?` → shortcut sheet.
- **Search-as-DSL** (replaces dedicated dropdowns once the loop feels right): `assignee=magos status=in_progress,blocked type=bug urgent` parses inline tokens out of the search field, falls back to ILIKE for the remaining text. Lets keyboard-first users skip the chip toggles and gives the search bar real power.
- Empty states for every list (illustration + 1-line copy + primary CTA).
- Skeleton loaders on every list and detail surface.
- Per-mutation toast confirmation; error toasts pull from API error envelope.
- Real-time-ish: TanStack Query `refetchOnWindowFocus` + 30s background refetch on the kanban / tickets list.

Out of scope for Phase 2 (deferred):
- Charts / dashboards (Phase 3)
- SSE / websocket real-time push (Phase 3 candidate)
- WIP limits on kanban columns (cheap to add; defer until needed)
- Audio playback (metadata-only display)
- Native automation rules editor (Phase 4)
- **Project ↔ repo linking + PR/commit indicators on cards.** Subsumed by
  Phase 4.5.2 (external refs / GitHub integration).
- **User-defined custom swimlanes.** Today swimlanes group by project /
  assignee / type. Expand to "named groups" — user defines categories like
  "Documentation row" or "Engineering row" and assigns tickets/labels/projects
  to them. Probably stored as `board.filter.swimlane` config plus a tagging
  mechanism. Defer until the basic swimlanes have shipped and we know the
  shape we want.

## Phase 3 — Dashboards & polish ✅

**Shipped** (minus 3.6, closed as won't-do). All planned dashboard surfaces, power tools, notifications, accessibility / keyboard nav, Playwright E2E coverage, and the two-container deploy split are in place.

Goal: the "how much work is left, how much done over time" view.

Locked breakdown:

- **3.0 — Stats/aggregation backend ✅.** `GET /v1/projects/:key/stats` (counts + by_category/priority/type/assignee + stale_in_progress + most_recent_activity), `GET /v1/stats/projects` (bulk feed for the directory), `GET /v1/stats/throughput` (closed-per-period over a window), `GET /v1/stats/cycle-time` (in_progress duration distribution; in_progress only — blocked excluded by design). Plus `system_settings` table + `GET/PATCH /v1/settings` for runtime config (default `stale_in_progress_days = 30`). All event-scan endpoints capped at 5000 events; 400 if exceeded. Side effect: ProjectsView ticket-count column lights up.
- **3.0b — Cumulative flow ✅.** `GET /v1/stats/cumulative-flow` for burndown + CFD charts. Split out because the per-bucket category replay over events is ~half the work of the other four combined. **CFD endpoint cap is 50,000 events** (vs. 5,000 for the other stats endpoints) since CFD inherently must scan project history, not just the window.
- **3.1 — Dashboards ✅.** Chart lib: **Apache ECharts via vue-echarts** (may roll our own later for visual polish). See "3.1 — Dashboards in detail" below for widget-level specs.
- **3.2 — Power tools on tickets list ✅.** Saved views (`saved_views` table, CRUD, palette integration) + bulk operations (multi-select, bulk-edit labels/assignee/status).
- **3.3 — Notifications / @mentions ✅.** Persistent notifications surface — `notifications` table, `mentioned_user_ids` extracted on comment/description write, dedicated unread/seen state, mark-as-read endpoint, dropdown in topbar, deeper integration with the homepage panel that 3.1 ships as a basic live-scan placeholder.
- **3.4 — Polish & a11y ✅.** Empty-state audit, skeleton-loader audit, keyboard-nav per-view (arrows primary, `j/k` alternate, `x`/`Shift+x` for bulk-select), ARIA audit, deprecated endpoint cleanup. **Configurable Projects columns**, **configurable Insights widget visibility**, and **command-palette `=`-token autocomplete** were deferred to Phase 5 — see "Deferred → Phase 5" below.
- **3.6 — Power-user shortcut adoption ❌ won't-do (SWY-32).** Tracking ticket only — no code work. Closed as not pursuing for now: the arrow-key default already covers daily use and there's no measurable win in forcing adoption of `j/k/x/e`. Reopen later if the alternate bindings become worth the muscle-memory cost.
- **3.7 — Container split: backend + frontend (no reverse proxy) ✅.** Refactored the single-container deploy into two: `server/Dockerfile` (Hono+Bun, API only) and `client/Dockerfile` (built Vue assets + a tiny Bun static server with SPA fallback that also passthroughs `/v1/*` and `/healthz` to the backend). What landed:
  - Root `Dockerfile` → split into `server/Dockerfile` + `client/Dockerfile`
  - Drop Hono's `serveStatic` middleware + the `notFound` SPA fallback; backend becomes API-only on its own port
  - New `client/serve.ts` (~50 LOC): static + SPA fallback + `/v1/*` `/healthz` passthrough via Bun's `fetch`
  - Root `docker-compose.yaml` with `switchyard` (backend) + `switchyard-frontend`, `depends_on: switchyard (healthy)`. Frontend exposes `${SWITCHYARD_PORT:-4002}:4002`; backend stays internal on `construct_net`
  - Update `compose-changes/README.md` to document the two-service merge into construct-server's stack
  - **Why no nginx/Caddy**: switchyard is tailnet-only, single human + agents. Gzip / immutable cache headers and "CDN-friendly" static serving don't justify a third moving part. A ~50-line Bun script handles static + SPA fallback + same-origin passthrough so the browser never needs CORS and no env-var injection is required. Backend keeps the service name `switchyard` so existing agent URLs (`http://switchyard:4002/v1/...` on `construct_net`) continue to work.
  - Locked decision in PHASES.md "Container shape" table updated to reflect the two-container shape.

- **3.5 — Playwright E2E ✅.** Pattern mirrors `Einlanzerous/legislator-lookup-tool-cc`: `playwright.config.ts` at the client root with `chromium` + `firefox` projects, `e2e/` directory, `webServer` block that boots `bun run dev` at `http://localhost:5173`, HTML reporter, trace on first retry. Phases:
  - **3.5.0 Scaffolding** — install `@playwright/test`, generate `playwright.config.ts` adapted for our `bun run dev` + bearer-token auth, add `client/e2e/` and `client/scripts/` for any seed helpers. `client/package.json` gets `test:e2e: "playwright test"` + `test:e2e:ui: "playwright test --ui"`. `.gitignore` skips `playwright-report/`, `test-results/`, `client/playwright/.auth/`.
  - **3.5.1 Auth fixture** — a setup project that hits `POST /v1/users/{magos}/tokens` with the bootstrap token, stores the resulting bearer in `playwright/.auth/admin.json` via `localStorage` injection, and reuses across all subsequent tests. Mirrors the auth-state pattern Playwright recommends.
  - **3.5.2 Smoke tests** — `e2e/smoke.spec.ts`: app boots, login flow, sidebar nav between Home / Tickets / Boards / Projects / Automations / Settings / Health renders without errors. Should run in <30s and gate every PR.
  - **3.5.3 Feature tests — list + filters** — `e2e/tickets.spec.ts`: filter DSL parses (`project=SWY assignee=me`), chips render and remove correctly, saved view round-trip (create → apply via menu → apply via palette).
  - **3.5.4 Feature tests — bulk ops** — `e2e/bulk.spec.ts`: multi-select via checkbox + range-select via shift-click, bulk assign / label / delete with toast verification, bulk transition modal with category mapping.
  - **3.5.5 Feature tests — board** — `e2e/board.spec.ts`: drag-to-reorder within a column persists the position, drag across columns fires a transition with the right resolution dialog when going to closed.
  - **3.5.6 Dashboard tests** — `e2e/dashboard.spec.ts`: KPI cards render numeric values, charts mount without console errors, stale-work widget visibility tracks the seeded data.
  - **3.5.7 CI workflow** — `.github/workflows/e2e.yml` running on push/PR to `main`, caching browser binaries, uploading the HTML report on failure.

  All tests run against the dev server (no separate test DB) using a deterministic seed in CI; locally you can point at any branch.

Locked Phase 3 decisions:

- **Cycle time counts in_progress only**, not blocked. Blocked time is its own future metric (companies tracking SLAs would care; personal use mostly doesn't).
- **Stale-in-progress threshold is a global system setting**, default **30 days** (low for personal use; lower for SLA-sensitive deploys).
- **Event-scan endpoints bounded at 5000 events** per request, 400 if exceeded — never silently truncate.
- **ECharts now**, may roll custom later if visual polish demands it.

Deferred from Phase 3 → Phase 5:

- **SSE / real-time updates.** Current 30s `refetchInterval` (shipped in 2.7) is acceptable for now. Revisit if "agent moved a ticket but my UI doesn't know" feels laggy in practice.
- **Configurable Projects columns** (Linear-style popover for toggling visible columns on the Projects directory). Originally scoped to 3.4; deferred because the default columns (key / name / open count / archived) cover the common case well enough.
- **Configurable Insights widget visibility** (per-tab "Customize" popover on the per-project + per-board Insights tabs). Same Linear-style popover primitive as the columns one — promote these together if the absence is felt.
- **Command-palette `=`-token autocomplete** (suggest project keys / user names inline when the caret sits right after `project=` or `assignee=`). Light implementation; defer until typing full names becomes annoying.

Cross-project board (`/boards/:id`) keyboard navigation is also pending — single-project board nav shipped in 3.4, but the swimlane variant has a 2-D grid that needs different focus tracking. Promote to Phase 5 if/when needed.

### 3.1 — Dashboards in detail

Three surfaces (personal HomeView + per-project Insights tab + per-board Insights tab) sit on top of one foundation: a small chart/widget framework. Build the foundation first, then the surfaces — the per-project tab reuses ~70% of the personal HomeView's widgets.

**Foundation:**

- `vue-echarts` + `echarts` (tree-shaken to: line, bar, pie, custom; canvas renderer).
- `<Chart>` wrapper: theme reactive to `themeStore.mode` (CSS-variable colors), responsive resize observer, "no data" empty state, height prop.
- `<DashboardWidget>` wrapper: title, optional `actions` slot (e.g. "View all →"), independent skeleton + error states so a flaky widget can't blank a whole dashboard.
- `<KpiCard>` for the small-numbers strip: label, big value, optional delta badge ("+12 vs 7d", green/red), optional sparkline.

**Personal HomeView — replaces current Phase tracker + health card:**

Layout (12-column grid; collapses to 1-column under `md`):

- **Row 1 — KPI strip (4 cards):**
  1. Open tickets (total across non-archived projects)
  2. In progress (count + "N stale" sub-line if `stale_in_progress > 0`)
  3. Closed this week (with 12-week sparkline)
  4. Median cycle time (formatted "3d 4h"; delta vs prior period)
- **Row 2 — "What needs me":**
  - **My open tickets (8 cols)** — `assignee=me AND status.category != 'closed'`. Compact rows: key, title, project, priority, status. Sortable. "View all →" deep-links to `/tickets?assignee=me`.
  - **@mentions (4 cols)** — basic live-scan v1 in 3.1: regex `@username` over comment + ticket-description text from the last 30 days. Surfaces "you have N at-mentions" with the relevant ticket links. **No read/unread persistence in 3.1** — that's the 3.3 Notifications scope. Section ships now so layout is right and an empty-state is meaningful even before 3.3 lands.
- **Row 3 — "What's happening":**
  - **Recent activity (8 cols)** — last 20 events across all projects. Actor avatar + action verb + ticket key/title + relative timestamp. Click row → opens drawer (`?focus=KEY`). Backed by existing `/v1/events`.
  - **Stale work (4 cols)** — rolls up at project level when ≥ 2 stale tickets in a project ("Switchyard · 17 stale", click → board filtered to in_progress); shows the single ticket row directly when only 1 stale. Driven by a new `GET /v1/stats/stale` endpoint that joins counts + a single sample ticket per project.
- **Row 4 — "How are we doing":**
  - **Throughput (6 cols)** — bar chart, closed/week, last 12 weeks, all projects.
  - **Status distribution (6 cols)** — donut of current ticket counts by category, all non-archived projects.

What moves out of the current Home:
- Phase-milestone tracker is dropped (PHASES.md is canonical).
- Health card becomes its own admin page — see "Health page" below.

**Health page** (admin sidebar item, replaces the home-page card):

- New top-level sidebar entry "Health" under the admin section.
- v1 (3.1): re-renders the existing `/healthz` subsystems block (DB latency, uploads dir, webhooks queue depth) as a real page rather than a card.
- Future-shape (out of 3.1 scope, but reserved): system health for the wider stack (Aperture pending-work widget for the construct-server install). Documented here so the page anticipates the layout.

**Per-project Insights tab** (new sub-route on `ProjectBoardView`, tabs "Board" / "Insights"):

- KPI strip scoped to the project (open / in_progress + stale / closed this week / median cycle).
- Throughput chart (this project, weekly).
- Status distribution donut.
- Cycle time: median + per-type breakdown bar (task / bug / spike / epic).
- Assignee leaderboard: top 5 by open-ticket count.

**Per-board Insights tab** (new sub-route on `BoardView`, tabs "Board" / "Insights"):

- KPI strip across the board's projects.
- **Cumulative flow** stacked area (uses 3.0b endpoint).
- Throughput aggregated across the board's projects.
- Status distribution by project (stacked bar).

**Both Insights tabs ship in 3.1.** User preference is per-board, but per-project is a small additional cost (mostly widget reuse with project scoping). Toggle / configurable widget visibility per-tab is 3.4 polish.

**New backend additions for 3.1** (to be added when their consuming widget is built):

- `GET /v1/stats/stale` — returns `{ items: [{ project: ProjectRef, stale_count: int, sample_ticket: TicketSummary | null }] }`. `sample_ticket` is populated when `stale_count == 1`, null when ≥ 2 (driving the project-rollup vs single-ticket display).
- `GET /v1/users/me/mentions?since=ISO&limit=N` — live-scan endpoint, returns `{ items: [{ ticket: TicketRef, comment_id: Uuid|null, snippet: string, mentioned_at: ISO }] }`. Detection is regex `@<name>` matching the requesting user's name; case-insensitive. Stateless — no read/unread tracking, that's 3.3.

**Order of build inside 3.1:**

1. Foundation (chart + widget components, theme integration, KpiCard).
2. Two new backend endpoints (`/v1/stats/stale`, `/v1/users/me/mentions`).
3. Personal HomeView — biggest user-facing impact; all subsequent widgets reuse from here.
4. Health page (small, mostly a re-skin of the existing card).
5. Per-project Insights tab — mostly widget reuse + scoping.
6. Per-board Insights tab — adds the CFD chart, otherwise mostly reuse.

## Phase 4 — Native automation rules ✅

**Shipped.** Rules engine, scheduled rules, named webhook targets, full Automations UI, imperium-loop integration (ticket links, custom fields, external refs incl. GitHub auto-attach), due dates, recurring/one-shot templates, sort by due date (incl. cross-board), default "All projects" board, cross-project ticket move, deploy disruption reduction, and the project navigation polish bundle. The only deliberately-cancelled item is 4.11 (drawer delete — superseded by 4.13b's detail-page delete).

Goal: replace simple "if X then Y" flows currently living in n8n with first-class switchyard rules. n8n keeps the multi-system flows.

### Locked decisions for Phase 4

- **Execution model:** async via in-process dispatcher (mirrors `webhooks/dispatcher.ts` — `FOR UPDATE SKIP LOCKED`, backoff, attempts, abandoned, redeliver). Bounded request latency, free retry+observability via the existing pattern. No in-band recursion risk.
- **Loop prevention:** rules skip events whose `actor_id` is the `rules-engine` system user. Simpler than causation-chain tracking; rule chains land in Phase 5 if needed.
- **Rule actor:** single `rules-engine` canonical agent user added to `seed.ts`. Audit log cleanly separates rule-authored events from human/agent ones.
- **Condition DSL:** flat JSONB. Ops `eq / ne / in / not_in / contains / is_null / is_not_null`. Combinators `all` / `any`, one level of nesting only — keeps the form-based builder UI honest. Field paths resolve against the event payload (`actor`, `ticket`, `changes`, extras); array path `ticket.labels[].name` is "any label matches".
- **Action retry policy:** auto-retry on infra errors (DB conflicts, transient failures) only. Action-internal failures (e.g. `move_status` rejected by the transitions table) mark the firing `failed` without auto-retry; admin redelivers via `POST /v1/rules/firings/{id}/redeliver`.
- **Scheduled rules:** deferred to 4.2. Event triggers ship first because they're the higher-value first cut; scheduled rules carry their own cron parser + ticket-query DSL.
- **Transition guards:** out of Phase 4. The hardcoded epic-close check (`server/src/routes/tickets.ts:504`) stays. Guards are sync-and-reject with a reason — a different shape from async after-the-fact rules. Revisit after daily rule use surfaces what guard primitives are actually needed.

### Schema

New migration adds two tables (modeled on `webhook_subscriptions` / `webhook_deliveries`):

- `rules` — `id, project_id NULLABLE (NULL in 4.1+), name, enabled, trigger_event_types TEXT[], conditions JSONB, actions JSONB, last_fired_at, created_at, updated_at`. Partial index on `enabled = true`.
- `rule_firings` — `id, rule_id, event_id NULLABLE (NULL for scheduled in 4.2), status (pending|running|succeeded|failed|abandoned|skipped), attempts, last_error, last_attempt_at, next_attempt_at, result_summary JSONB, created_at`. Partial index on `status IN ('pending','failed')`.

`writeEvent` (`server/src/lib/events.ts`) gains a second fan-out after the webhook enqueue: query matching enabled rules and insert `rule_firings` rows, skipping when `actor_id = rules-engine`. Conditions are evaluated by the dispatcher, not at enqueue time, so even firings whose conditions fall false get logged as `skipped` for debugging.

### Action catalog

| Action | Shape | Ships in |
|---|---|---|
| `set_field` | `{ type: "set_field", field, value }` — whitelist: priority, due_date, parent_id, metadata.* | 4.0 |
| `add_label` | `{ type: "add_label", label }` — creates label if missing | 4.0 |
| `comment` | `{ type: "comment", body }` — supports `{{ticket.key}}` / `{{actor.name}}` / `{{rule.name}}` templating | 4.0 |
| `assign` | `{ type: "assign", user }` — name or id | 4.1 |
| `move_status` | `{ type: "move_status", to_category, resolution? }` — validates project's transitions table | 4.1 |
| `fire_webhook` | `{ type: "fire_webhook", url, method, headers? }` — HMAC-signed | 4.1 |
| `call_n8n` | `{ type: "call_n8n", workflow }` — `fire_webhook` prefixed by `N8N_BASE_URL` env | 4.1 |

Actions execute as `rules-engine` and route through the same helpers human handlers use (`loadTicketSummary`, `writeEvent`), so audit + downstream rule eligibility come for free.

### Milestones

- **4.0 — Foundations + event-triggered rules + 3 core actions ✅ (SWY-28).** Migration, `rules-engine` seed user, Zod schemas (`shared/src/schemas/rule.ts`), `lib/rules/{dispatcher,evaluator,actions,types}.ts`, `writeEvent` fan-out, CRUD routes + firings log + redeliver, health subsystem (`rules: { queue_depth }`, warn at 500), new `rules:manage` scope. Tests: unit (evaluator: every op, missing-field, nested), integration (rule fires → action lands → second event written → no infinite loop). Codegen `client/src/lib/api.types.ts`.
- **4.1 — Remaining actions + cross-project + safety ✅ (SWY-29).** Add `assign` / `move_status` / `fire_webhook` / `call_n8n`. Allow `project_id IS NULL` rules (global). Per-rule rate limit (default 100/hour, env `RULE_RATE_LIMIT_PER_HOUR`; over-limit firings get status `skipped`).
- **4.2 — Scheduled rules ✅ (SWY-30).** Add `schedule_cron` + `target_query` columns with a CHECK enforcing exactly-one-trigger-mode. Cron parser (`cron-parser`, ≈30KB). `lib/rules/scheduler.ts` polling loop, 60s tick, fires one `rule_firings` row per ticket matched by the rule's `target_query` (reuses the existing `/v1/tickets` filter shape — no second DSL).
- **4.2.5 — Named webhook targets ✅ (SWY-35).** Decouple webhook URLs from the rules and subscriptions that reference them. New `targets` table (`name`, `url`, optional `hmac_secret`, optional `headers`). `webhook_subscriptions.target_id` nullable FK. `fire_webhook` action gains a `{ target, path? }` variant alongside the URL form; `call_n8n` becomes thin sugar over a target named via `N8N_TARGET_NAME` env (default `n8n`), with `N8N_BASE_URL` still working as a fallback during rollout. New `targets:manage` scope. DELETE rejects with 409 + referencer list when anything still points at the target. Ships before 4.3 so the UI lands with target pickers from day one.
- **4.3 — UI: rules / firings / targets under Automations ✅ (SWY-33).** `AutomationsLayout` already exists; add nav links for `/automations/rules` and `/automations/firings`. Form-based rule builder ("When [event-type] AND/OR [field op value] Then [action]") via vee-validate + Zod. Firings table with redeliver button and drawer that renders `result_summary` (matched conditions, action outcomes).
- **4.4 — Polish + docs ✅ (SWY-34).** README "Automation rules" section (DSL grammar, action catalog, 3–4 worked examples). Recent-firings debug surface. E2E test (`client/e2e/automations.spec.ts`). Empty/skeleton audit.
- **4.5 — Imperium-loop integration: ticket links + custom fields + external refs ✅ (SWY-37 epic).** Three coupled primitives the imperium-loop migration needs once test-firing starts. Closeout push for Phase 4 — bundled rather than scattered through Phase 5 because they're tightly coupled to how agents will use switchyard in practice.
  - **4.5.0 — Ticket links ✅ (SWY-38).** New `ticket_links` table for typed relations: `blocks` / `relates_to` / `duplicates`. Bidirectional rendering (A blocks B shows as "blocked by A" on B; rendered from a single row, not two). `parent_id` stays as the epic→child mechanism (separate primitive — postgres trigger keeps enforcing the epic-only invariant). Events `ticket.link_added` / `ticket.link_removed` so rules and webhooks can react. UI: drawer section on TicketDetail with add/remove + jump-to.
  - **4.5.1 — Custom field schemas ✅ (SWY-39).** `custom_fields` table declaring typed views over `metadata.<key>`: `text` / `number` / `boolean` / `url` / `select` (options jsonb for select). Per-project or global (`project_id` nullable). Surface flags: `show_on_card`, `show_on_create_form`, `show_on_filter_bar`. Filter integration: `?cf.<key>=<value>` on the tickets list. The existing `metadata` JSONB stays — defined fields are typed views over known keys, not a new column. Lets imperium-loop stash `cogitation_run_id`, `deploy_url`, etc. as first-class queryable state without a migration per key.
  - **4.5.2 — External refs: manual attach + polling ✅ (SWY-40).** `ticket_external_refs` table: `kind` enum (`github_pr` / `github_issue` / `github_commit` / `github_action` / `generic`), `url`, `state` (open / closed / merged / success / failed / null), `title`, `polled_at`, `polled_state_changed_at`. Manual attach via UI/API; state refreshed every ~5min via GitHub API (`GITHUB_TOKEN` env). UI: card slot badges (open PR, merged PR, CI pass/fail) embedded in `TicketSummary` so kanban cards render without a follow-up fetch; ticket-detail section listing refs. **Two nits bundled here** because they touch the same surfaces: (a) board header gets a "Show epics" toggle (default off, persisted in `board.filter` for cross-project boards, URL query for per-project); (b) when a ticket transitions to closed with `parent_id` set AND all siblings closed, a pure-frontend modal asks whether to close the parent epic too.
  - **4.5.3 — External refs: push-mode webhook + auto-detect ✅ (SWY-41).** `POST /v1/external/github` accepts GitHub webhooks (HMAC-verified with `GITHUB_WEBHOOK_SECRET`). On `pull_request` events, parses `SWY-\d+` out of PR title + head branch name and upserts the matching `ticket_external_refs` row — auto-attach without explicit user action. Subsequent merge/close transitions push state into the same row. Polling from 4.5.2 stays active as the reconciliation backstop. **Wildcard prefix** (`EXTERNAL_REF_KEY_PREFIX=*`) supports multi-project matching against any `<KEY>-<NUM>` shape.
- **4.6 — Due dates ✅ (SWY-42).** Surface the `due_date` field that's been on the schema since Phase 1 but never in the UI. Drawer + detail editor (popover + native date input, anchored to local midnight), board cards (calendar icon + relative date, red left stripe when overdue), list rows (column + overdue accent), activity feed (readable dates). Filter chips: Overdue / Due this week / No due date. Two new insights tiles: **Overdue** (open, past due — live) and **Completed late** (closed tickets that shipped after due_date — all-time).
- **4.7 — Recurring + one-shot ticket templates ✅ (SWY-43).** New `ticket_templates` table unifies cron-recurring ("Monthly review") and one-shot lead-time ("Rotate tokens before 2026-08-15") under one entity with an XOR check. Materializer hooked into the rules scheduler's 60s tick, three overlap policies (`skip` / `always` / `reuse_open`), `last_fired_at` stamped before materialize to prevent double-fire. 7 API endpoints (CRUD + `fire_now` + instances feed). Vue Recurring tab on each project with editor dialog (4 cron presets + advanced custom + tz picker). "Recurring" pill on materialized instances links back to their template.
- **4.8 — Sort tickets by due date, incl. cross-board ✅ (SWY-44).** Cursor pagination generalized from `(updated_at, id)` to an arbitrary nullable `(key, id)` shape (NULLS LAST enforced regardless of direction). `GET /v1/tickets` accepts `sort_by` ∈ {`updated_at`, `due_date`, `created_at`, `priority`} and `sort_order` ∈ {`asc`, `desc`}; priority sorts via a SQL CASE ordinal. Boards (per-project + cross-project) ship a client-side `compareTickets` with modes {`smart`, `due_date`, `priority`, `position`, `updated`, `created`} — `smart` floats dated tickets to the top while keeping `position` as the tiebreaker, so drag-reorder remains real-time guidance ("if no due dates, you don't notice anything"). Sort selector dropdown on the tickets list, per-project board, and cross-project board headers; URL-synced. Legacy `{u,i}` cursors still decode for in-flight pagination tokens.
- **4.9 — Default "All projects" board ✅ (SWY-49).** Auto-seeded on first boot, includes every active project. New `boards.auto_include_all_projects` flag with partial unique index (one auto-board max) + `default_board_deleted` system setting so it stays deleted. Lifecycle hooks on project create/archive/unarchive/delete keep membership in sync. Manual project edits flip the flag off — once the user touches it, they own it. UI: "Auto" pill on the board card + explanatory note in Edit Board dialog.
- **4.10 — Move ticket to a different project ✅ (SWY-50).** Re-home miscategorized tickets without delete+recreate. `POST /v1/tickets/:idOrKey/move` allocates a new key in the destination project, remaps status via fallback chain (explicit `status_id` → exact name+category → unique-by-category → 400 with candidates), and clears `parent_id` when it doesn't carry over. All ticket-id-keyed relationships (comments, attachments, labels, external refs, links, metadata) ride along automatically. New `ticket_aliases` table keeps old keys (LOOP-3) resolvable forever — agents / GitHub references / n8n payloads that cached the old key keep working. New `ticket.moved` event type fires through webhooks + rules. UI: ⋯ menu in TicketDrawer → MoveTicketDialog with ambiguity surfacing.
- **4.11 — ❌ cancelled (SWY-51).** Original scope put delete in the drawer; superseded by 4.13b which puts it on the dedicated detail page instead. Drawer stays delete-less.
- **4.12 — Less disruptive deploys ✅ (SWY-54 / 55 / 56).** Deploys used to leave the backend returning 503 to the frontend passthrough for 30–120s during container restart. Three sub-tasks, all shipped in PR #28:
  - **4.12a — Frontend retry buffer ✅ (SWY-54).** Bun passthrough (`client/serve.ts`) retries 503 / connection-refused on a 15s deadline at 200ms intervals; non-idempotent verbs short-circuit on first 5xx. Exhausted retries return a deploy-aware 503. Combined with TanStack Query's 2-attempt default, the visible-failure budget is ~18-20s — most deploys are invisible.
  - **4.12b — Startup profile ✅ (SWY-55).** `[boot]` per-phase timing in `server/src/index.ts` and `[migrate]` per-phase timing in `server/src/lib/migrate.ts` make the long pole obvious in `docker logs` without external profiling. Listen-before-workers reordering means `/healthz` answers before the scheduler / dispatcher / external-ref poller spin up.
  - **4.12c — Migration safety guidelines ✅ (SWY-56).** `docs/migrations.md` codifies the five rules (additive only on hot tables, two-PR ladder for destructive changes, batched backfills, no CHECK-with-subquery, CONCURRENTLY for indexes on populated tables) and audits all 17 existing migrations — net verdict: no outstanding remediation.
  - (Blue/green via reverse proxy stays deferred to Phase 5; 4.12a + 4.12b are expected to cover the observed pain.)
- **4.13 — Project navigation polish ✅.** Three coupled UX nits bundled.
  - **4.13a — Repo URL on projects ✅ (SWY-57).** New `projects.repo_url` column surfaced on `ProjectRef`. New `ProjectHeaderLabel` component: project key stays inert (font-mono), the name becomes a link to the repo when `repo_url` is set. Settings → Projects edit form gains the input.
  - **4.13b — Delete on ticket detail page + list-view UX ✅ (SWY-58).** TicketDetailView header gains a destructive Delete with two-step inline confirm. Drawer intentionally has no delete affordance — the dedicated detail page is the right surface. BulkActionBar's delete confirm no longer floats over the action row with `absolute inset-0`; it replaces the action row inline.
  - **4.13c — Consolidate Recurring into project Setup tab ✅ (SWY-59).** New `/projects/:key/setup` tab replaces the standalone Recurring tab. Three sub-tabs: Recurring (lifted from old view), Automations (project-scoped rules + read-only section of global rules also affecting the project), Settings (project metadata edit incl. repo_url, links out to Statuses + Transitions editors). Old `/projects/:key/recurring` URL redirects to the new path.

Out of scope for Phase 4 (incl. 4.5):

- Pluggable transition guards (the hardcoded epic-close check stays).
- Rule chains / causation tracking (rules-engine events skip the engine — no recursion).
- Multi-level nested conditions deeper than one level.
- Auto-disable on N consecutive failures.
- "Run rule now" debug button.
- True zero-downtime deploys (blue/green) — deferred to Phase 5; 4.12a is expected to cover most cases.

## Phase 5 — Agent orchestration & observability

Phase 5 hardens switchyard as the **agent-facing source of truth** — the place every coding agent (today: Claude, Gemma 31b via imperium-loop; tomorrow: optionally Cline) reads and writes work — and instruments the agentic pipeline so cycle-time decisions stop being vibes. Tracked as **SWY-45 epic**.

### Locked decisions for Phase 5

- **Imperium-loop stays whole.** The n8n + Servo-Signal + Autosavant pipeline keeps running as-is. Phase 5 adds infrastructure imperium-loop can *optionally* consume (MCP server), not a replacement.
- **MCP server first, not last.** Originally deferred behind a "skill teaches conventions" bet. The launch of Cline Kanban (Feb 2026) and the broader 2026 reality of MCP as the canonical agent integration protocol changes the calculus — MCP is now the bridge every consumer (imperium-loop nodes, Claude Code, Cline experiments, future tools) benefits from equally.
- **Hand-curated MCP, generated types underneath (Option C).** ~8–10 tools shaped for LLM consumption — descriptions written for agents, composed workflows where useful, invariants the OpenAPI schema can't express (PATCH-vs-transition, idempotency, etc.) encoded in tool docs. Request/response TypeScript shapes come from `api.types.ts` (already generated) so HTTP plumbing stays current even when the maintained MCP surface lags behind new endpoints. Auto-gen alone was rejected because tool descriptions are noise and the 50+ endpoint surface bloats agent context with admin tools agents shouldn't call.
- **Cline is exploration, not foundation.** We don't build *for* Cline; we build the MCP server and skill for the current setup (imperium-loop's agents) and test whether Cline Kanban consumes it via the standard MCP path. If yes, great. If no, no architectural reshuffle.
- **Observability before zero-downtime deploys.** You can't tune what you can't see; capacity decisions wait on data. Blue/green deploy lands in Phase 5 only if Phase 4.12a turns out to be insufficient.
- **Switchyard renders, plugins own their data.** Plugin contract (5.2) lets external systems surface read-only widgets in switchyard without polluting its DB. Comes after MCP because MCP is what unlocks broader agent integration; plugin contract is the inverse direction (external → switchyard UI).

### Milestones

- **5.0 — Switchyard MCP server ✅ (SWY-36).** New top-level `mcp/` package. Stdio transport (Claude Desktop, Cline, Claude Code, Gemini CLI install patterns); HTTP transport optional for remote consumers. Hand-curated tool surface:
  - **Reads:** `list_tickets` (filter shape mirrors `/v1/tickets` incl. SWY-44 `sort_by`), `get_ticket`, `list_projects`, `get_project_statuses`, `query_my_open` (sugar over list_tickets).
  - **Writes:** `create_ticket`, `update_ticket` (PATCH, no status — the invariant is in the tool description), `transition_ticket` (status change with required resolution when closing, optional comment), `comment_on_ticket`, `move_ticket` (Phase 4.10 feature).
  - **Auth:** `SWITCHYARD_TOKEN` env per actor (`claude`, `n8n-cogitation`, etc. — same per-agent token model in use today). `SWITCHYARD_URL` env defaults to `http://localhost:4002`.
  - **HTTP plumbing:** openapi-fetch against `api.types.ts` (generated from `openapi.yaml`), copied or symlinked into `mcp/`. New REST endpoint doesn't auto-land in MCP — explicit curation by design.
  - **Distribution:** `bun link` for local dev, eventually `npm publish` as `@switchyard/mcp` once stable.
  - **Out of scope:** attachments (multipart over MCP is awkward — defer until a consumer asks); webhook/rule subscriptions (separate primitive); resource-style ticket pages (start tools-only).
  - **Landed in PR #31:** all nine tools wired, in-memory test harness (`InMemoryTransport` + mocked fetch), invariants documented in tool descriptions. SDK pinned at `^1.29.0`. Live end-to-end smoke verified against :4002 via the SWY-36 close itself (`transition_ticket` round-trip). Follow-ups in SWY-60 (live :4012 smoke) and SWY-61 (error-path test coverage).
- **5.1 — Observability for the agentic pipeline ⏳ (SWY-48).** Decision document FIRST — measure custom-metric volume vs. Datadog free tier, then pick between Datadog / OpenTelemetry + Grafana / SigNoz / in-house build. Once chosen, emit structured metrics from every service family (n8n cogitation-engine, servo-signal, autosavant-bot, switchyard backend, Anthropic/Gemini API spend). Four dashboards (bottleneck / cost-per-ticket / cycle health / capacity headroom) and five alerts (HITL stalls, cycle-time regressions, API rate-limit hits, cost spikes, sandbox zombies). Surface 3 KPI tiles in switchyard via the SWY-47 plugin contract; deep dashboards live in the chosen backend.
- **5.2 — Integration plugin contract ⏳ (SWY-47).** Lets external systems surface live state inside switchyard without polluting its data model. Three pull endpoints per registered plugin (`/ticket/:key/activity`, `/project/:key/kpis`, `/webhook` for push updates) + an `integration_plugins` table for registration (name, base_url, auth_token_hash, enabled, capabilities). Switchyard caches responses 30s and skips plugins that don't respond < 1s. UI: drawer Integrations row + project Insights "From integrations" KPI tile row + Settings → Integrations admin. Imperium-loop is the first consumer (n8n workflow `switchyard-plugin` exposes the three endpoints, surfacing live agent run-state on the relevant tickets).
- **5.3 — Cline integration spike ⏳ (new ticket TBD).** Treat as exploration, not strategic dependency. Decision document FIRST: does Cline Kanban (the agents running inside it) consume the switchyard MCP server out of the box, and does that produce a usable workflow? Test plan:
  - Install switchyard MCP server in a fresh Cline Kanban setup.
  - Mint a per-actor token (`cline-magos` or similar) against `switchyard_test`.
  - Try driving a real-ish workflow: dictate a ticket via Vox-Dictate path → switchyard → trigger Cline Kanban agent → agent reads ticket via MCP, works in worktree, comments back on the ticket → ticket transitions on PR merge.
  - **Outcomes:** (a) works end-to-end → keep Cline as an optional consumer alongside imperium-loop, document the setup. (b) partial / clunky → write down the gaps, defer further work. (c) "fuck it, we build it ourselves" → file follow-ups for native worktree-per-card / agent invocation features on switchyard's own kanban. This third path is only entertained if the first two reveal blockers worth the cost of building our own.

### Candidates queued but not yet ticketed

- **Cross-ticket aggregation in rule conditions** (flagged by imperium-loop IL-5). Add a `count` condition op so rules can express "count tickets where `metadata.<key> = <value>`" — needed to make IL-5's graduation rule atomic instead of relying on the scheduled-rule fan-out fallback. Could land as a small Phase 4 extension (preferred if a second use case shows up) or via the Phase 5 plugin contract if we'd rather externalize the query.
- **Smart initial-position at ticket-create time.** Original 4.8 wish was "I added a new ticket due before ticket 5, so it's placed above 5 automatically." Shipped 4.8 stopped short — view-time `smart` sort with due_date as the primary key made drag-reorder snap back, so smart was aliased to manual position order. The right fix is at create time: on `POST /v1/tickets` with a due_date, compute the initial position via fractional indexing against the destination column's neighbors with the closest due_dates. Then default board sort stays position-based (drag wins), but new tickets land where the user expected. ~30 LOC server-side, no schema change. Edge cases: empty column (use `Date.now()`), no neighbors with due_date (use newest-first stack).
- **QR-code device login (SWY-63 ⏳).** Friction point: signing into prod from a phone / tablet or into dev from a second machine currently means copy-pasting a bearer token across devices. Fix: extend `/settings/tokens` so the "show secret once" banner also renders a QR that wraps the freshly-minted bearer in a `${origin}/login?token=…` URL — a phone's native scanner opens the browser directly at `/login` with the token pre-filled. `/login` also exposes an in-app "Scan QR" affordance that decodes via the browser's `BarcodeDetector` for desktop-to-desktop scans. Per-device token names (e.g. "tablet 2026-05") so a lost device can be revoked individually. Tailnet-only deploy makes the QR-on-camera-shot risk negligible.
- **Blue/green deploys** via Caddy or Traefik. Only if Phase 4.12a (frontend retry buffer) doesn't cover the observed pain.
- **S3-compatible attachment storage** — only if filesystem becomes painful (size, sharing across multiple containers, off-host backup).
- **Sprints / cycles** — only if the workflow benefits from time-boxed planning. Probably not.
- **Time tracking** — only if asked.

## Phase 6 — Multi-user & permissions ⏳

Phase 6 turns switchyard from "one human + N trusted agents who all see everything" into a multi-user instance where each human is scoped to the projects they're a member of, with role-based read/write. Motivating case: invite a friend as a **read-only viewer** on a single project (e.g. a shared Plex setup) without exposing the rest of the instance. Tracked as **SWY-94 epic**.

This is **multi-user, still single-tenant** — not the multi-tenant / multi-org split, which stays a non-goal (see below).

### Locked decisions for Phase 6

- **Auth mechanism unchanged.** Bearer tokens stay. New humans get in by an admin minting them a user + token (shared via the SWY-63 QR flow). No OAuth/SSO.
- **Two-dimensional authz.** Effective permission = the token's global scopes ∩ the user's role on the project. Global scopes keep meaning what they do today; the project dimension is new.
- **Instance role on users** (`owner | member`). `owner` = magos (full instance admin). Migration backfills magos→owner.
- **Per-project role** on `user_projects.role` (`admin | editor | viewer`). `viewer` = read-only; `editor` = ticket/comment writes; `admin` = project config. The friend is `viewer` on one project. (Membership reuses the pre-existing, previously-unused `user_projects` join table from Phase 0 — same naming family as `board_projects` / `ticket_labels` — rather than a new `project_members` table.)
- **Agents are instance-wide service accounts** — they bypass per-project membership and keep seeing everything. Keeps imperium-loop working unchanged; no per-project migration of agent tokens.
- **Default-deny for `member` humans** — a member sees only projects they belong to. Owners + agents keep blanket access. This is the behavior change that makes scoping real.
- **`admin` token scope = instance-admin.** Existing `admin` tokens (magos, agents) keep full access. Humans get project-level admin via their project role, not the global `admin` scope.
- **Reads 404, writes 403 for non-member resources.** Reads return 404 (not 403) so a viewer can't probe for the existence of projects/tickets they can't see.

### Milestones

- **6.0 — Authz foundation ✅.** Added `role` (`project_member_role` enum) to the existing `user_projects` join table; added `users.instance_role` (`owner | member`, default `member`). `lib/authz.ts` ships `hasInstanceWideAccess`, `visibleProjectIds`, and `effectivePermissions(user, token, projectId)` (token scopes ∩ project role → read/write/manage capability set). Seed backfill: magos→owner + `admin` membership in every project; agents bypass. Migration `0019_swy_95_project_membership`. No endpoint wired yet. Unit-tested in `test/lib/authz.test.ts` + `seed.test.ts`.
- **6.1 — Read-path enforcement** ⚠️ *the data-leak surface; the bulk and the risk of the phase. Split into six independently-mergeable sub-milestones.*
  - **6.1.0 — Enforcement primitives + playbook ✅.** The linchpin everything else depends on. `lib/authz.ts` gained the **scoped query helper** `visibleProjectFilter(user, projectIdCol)` (filters at the SQL layer — `null` for instance-wide, `project_id IN (…)` for members, a `FALSE` predicate for zero-project members so pagination + counts stay correct — never fetch-then-filter) plus the **404-not-403 read convention** (`assertProjectReadable` throws 404 for non-member detail reads; `canSeeProject` for the boolean check). **Negative-access test matrix** harness at `server/test/integration/negative-access.test.ts` (fixture: owner / agent / `viewer`-on-PLEX-only `friend`; every later sub-milestone appends its endpoints, asserting 404/empty for non-member projects) — includes a cursor-pagination-preservation test. `docs/permissions.md` written (the playbook below). Advisory CI guard `server/scripts/authz-guard.ts` flags handlers querying `tickets`/`projects`/`boards` without an authz helper (flip to a failing gate after 6.1.5). Unit coverage extended in `test/lib/authz.test.ts`. No endpoint behavior change beyond wiring.
  - **6.1.1 — Ticket reads + inherited resources ✅.** Wired the 6.1.0 primitives into the read path: `tickets.ts` list (SQL-layer `visibleProjectFilter`, composes with `?project=`), detail/`events`/`children`, `comments.ts` list, `ticketLinks.ts` + `ticketExternalRefs.ts` list, and `attachments.ts` `GET /v1/attachments/{id}` + `/meta` — all via `assertProjectReadable` (404, not 403). Inherited resources resolve to the parent ticket's project first; attachments walk up through `comment_id → comment → ticket` when not directly ticket-attached (`attachmentProjectId` helper). The negative-access matrix now boots the real Hono app and drives every endpoint over HTTP as a `viewer`-on-PLEX (SWY reads → 404, PLEX → 200), alongside the lib-level primitive tests. Advisory `authz-guard.ts` flag list shrank 14 → 9. Cross-project link metadata stays intentionally visible (write-isolation, not read-secrecy, is the goal). Highest traffic + highest leak risk.
  - **6.1.2 — Project config reads ✅.** `projects.ts` list (`visibleProjectFilter`) + get, `statuses.ts` (statuses + transitions lists), `ticketTemplates.ts` (project list, `GET /v1/templates/{id}`, instances), `customFields.ts` (`?project=` gated; unscoped list returns globals + visible projects' fields; `GET /{id}` gated when project-scoped) — all via `assertProjectReadable` (404). **Carve-outs (confirmed during build, documented in `docs/permissions.md`):** `labels.ts` stays instance-wide (global catalog, `name`+`color`, no `project_id`) and **global custom fields** (`project_id NULL`) stay visible to all (instance-wide config the create form needs) — only project-scoped fields gate. Negative-access HTTP matrix extended; advisory `authz-guard.ts` flag list shrank 9 → 5.
  - **6.1.3 — Boards ✅.** `boards.ts` (list, get, columns). A member sees a board iff they belong to ≥1 of its projects; within a visible board only their own projects' refs + cards. List pushes an `EXISTS (board_projects ⋈ projects)` predicate (pagination intact) then narrows refs; get/columns intersect board projects with the member's and drive the card query off that set, so the auto "All projects" board **drops non-member columns/cards** rather than 404ing. **Decision:** a board with zero projects the member can see (single-project non-member board, cross-project board they're in none of, or empty board) is dropped from the list AND 404s on direct fetch — never visible-but-unloadable; instance-wide actors unaffected. Swimlanes are client-side over the cards, so the card filter covers them. Built on `visibleProjectIds`/`hasInstanceWideAccess` (boards' M2M defeats single-column `visibleProjectFilter`); `authz-guard.ts` flag list shrank 5 → 4.
  - **6.1.4 — Aggregates & feeds ✅.** `events.ts` global feed (`visibleProjectFilter`; explicit `?project=` non-member → 404) and all `stats.ts` endpoints (`projectStats` via `assertProjectReadable`; `/stats/projects` member-scoped SQL; throughput/cycle-time/cumulative-flow via a shared `resolveStatsScope`; `/stats/stale` via `visibleProjectFilter`). **Conflation fix:** the window endpoints overloaded `projectIds.length === 0` to mean both "all projects" and "named-but-none-matched" — a zero-project member fell through to the all-data branch; `resolveStatsScope` returns explicit `{projectIds, unfiltered}` where members are never `unfiltered`. Search DSL was already scoped in 6.1.1 (assertion only). **Carve-out:** `/v1/users/me/notifications` left unscoped — own @-mentions stay visible cross-project (read-visibility soft; write-isolation is the goal); `users.ts` stays on the advisory guard list deliberately (needs an allowlist when 6.1.5 flips the gate). authz-guard flag list 4 → 2 (`rules`, `users` remain).
  - **6.1.5 — Admin-surface audit ✅.** Audited `rules.ts`, `targets.ts`, `webhooks.ts`, `settings.ts`, `users.ts`, `llmObservations.ts`. **Admin infra → instance-admin only:** all reads on rules/targets/webhooks (list/detail/firings/deliveries) now gate on a new `assertInstanceAdmin(user)` (403 for members; owner + agents pass — keys on instance role, not token scope, so read-only owner tokens + imperium-loop agents keep working). Rules reads are fully instance-admin in 6.1.5 (no project-member rules view). **`users.ts` directory → co-members:** `GET /v1/users` filtered to co-members ∪ agents ∪ self via new `visibleUserIds`; `GET /v1/users/{id}` 404s outside that set. **Gap fixed:** `GET /v1/users/{id}/tokens` had no scope check (leaked token metadata) → now `users:manage`. **Carve-out:** `GET /v1/settings` stays readable (non-secret display config the member UI needs); PATCH stays `admin`. `llmObservations.ts` write-only, no change. **authz-guard flipped to ENFORCING** + wired into `ci.yml`; flag list 2 → 0. Negative-access matrix extended (6.1.5 block). Write-path enforcement is 6.2.
- **6.2 — Write-path enforcement + roles ✅.** Every mutating handler gates on the project-role dimension on top of its existing `checkScope` (effective = token scope ∩ project role, enforced as a two-gate conjunction so per-scope precision survives). New `assertProjectRole(user, projectId, "write"|"manage", resource)` (403). **Project-scoped writes → `write` (editor+):** tickets create/update/delete/transition/move (move needs write on *both* ends), comments, attachments, ticket links + external-refs, templates. **Project-config → `manage` (project admin):** project edit/delete, statuses + transitions, project-scoped custom fields. **Instance surfaces → `assertInstanceAdmin`:** project *creation*, boards, rules/targets/webhooks, labels, users + tokens, settings PATCH, global custom fields. `checkScope`'s `admin` short-circuit = instance-admin; project-admin = the role gate (the "split" the ticket asked for). **Templates ship editor-tier** (ticket-adjacent), not project-admin — diverges from the ticket wording; SWY-102 corrected. authz-guard extended to flag unscoped *writes* too; negative-access matrix gained a 6.2 block (viewer blocked even with a broad token; editor writes tickets not config; project admin configs own project only; owner/agent regression). Read-only-token reconciliation is 6.3.
- **6.3 — Read-only tokens & viewer-role enforcement (absorbs SWY-74) ✅.** Generalizes "read-only by construction": the dashboard token-kind **and** the viewer role both yield read-only, converging on one predicate. Token `kind` enum (`personal | agent | dashboard`, default `personal`, additive migration `0020`); `agent` is descriptive-only, only `dashboard` is enforced. **Dashboard = read-only by construction:** the create handler caps scopes to `READ_ONLY_SCOPES` (`tickets:read` today), auto-fills when omitted, and 400s a write scope with `details.reason = "invalid_scopes_for_kind"` (handler check, not a Zod refinement — no token-update endpoint exists, so it can't drift). **Convergence:** `effectivePermissions` (scope ∩ role) is the single read-only predicate both a dashboard token (capped scopes) and a viewer (role) resolve through; enforcement stays the two 6.2 gates (`checkScope` 403s the capped token's write, `assertProjectRole` 403s the viewer). Client: a **Dashboard token** button (no scope picker) + a read-only badge in `/settings/tokens`. Scoped public demo = a dashboard token on a `viewer` user (documented manual step). Ticket corrected: `invalid_scopes_for_kind` ships as `bad_request` + `details.reason` (closed `ErrorCode` enum); "optional expiry" dropped (no expiry column).
- **6.4 — Membership & invite UI ✅.** Settings → per-project **Members** (add/remove, set role); admin user management gains instance-role + token mint for a new human; "show secret once" banner surfaces the QR (SWY-63 synergy). Project payload now carries `my_role` (`effectiveProjectRole`) — the field the client gates UI on in 6.6.
- **6.5 — Agents & service-account hardening ✅ (PR #99).** Formalized the owner/agent bypass as the single `hasInstanceWideAccess` predicate and locked it in — `authz-guard.ts` gained a *bypass* dimension that fails CI on a bare `type === "agent"` in a handler. Negative-access regression asserts every imperium-loop per-actor token reads + writes cross-project with zero membership rows. Service-account model documented in `docs/agents.md`.
- **6.6 — Docs + E2E ✅.** `docs/permissions.md` finalized + `docs/agents.md`/`docs/mcp.md` updated. **Client-side write gating (new):** `useProjectPermissions` derives `canWrite`/`canManage`/`isReadOnly` from `my_role`, hiding New-ticket / inline editors / transition / comment composer / New-project for viewers + a read-only banner (cosmetic — server stays the source of truth). **E2E** `client/e2e/permissions.spec.ts` drives the seeded `viewer-user` (viewer on TEST, not a member of LOCKED): sees only TEST, write affordances absent, direct-URL to LOCKED project/ticket 404s, API writes 403. Chromium + firefox.

### Enforcement playbook (6.1.0 deliverable, lives in `docs/permissions.md`)

1. **Default-deny, centralized.** Every project-scoped read goes through the shared helper; no ad-hoc membership checks inline in handlers.
2. **Filter at the query layer, not after** — fetch-then-filter breaks cursor pagination and counts.
3. **Inherited resources resolve up** to their parent ticket/project membership, never their own row in isolation.
4. **Reads 404, writes 403** for non-member resources — don't leak existence on reads.
5. **Owner/agent bypass is one predicate** (`hasInstanceWideAccess`), explicit and tested — never scattered `type === 'agent'` checks.
6. **Every read-endpoint PR extends the negative-access matrix** — a new read without a matrix row fails review.
7. **Optional CI guard:** a grep-test flagging handlers that query `tickets`/`projects`/`boards` without routing through the scoped helper.

---

## Locked architectural decisions

These were settled during planning. Don't relitigate without naming the *why* listed here.

| Decision | Choice | Reason |
|---|---|---|
| Backend lang | Hono on Bun | Type-share with frontend via Zod; Bun's memory profile is closer to Go than Node-Express; the user already runs n8n so the runtime isn't foreign. |
| Frontend lang | Vue 3 (not React) | User preference, stated explicitly. Default for all switchyard frontend work. |
| Container shape | Two containers (backend API + frontend static-with-passthrough) | Independent rebuild + concern separation. Frontend is a tiny Bun server that serves the Vue bundle + SPA fallback and passthroughs `/v1/*` and `/healthz` to the backend, so the browser stays same-origin and no nginx/Caddy is needed. Tailnet-only deploy means CDN-style static serving isn't a goal. |
| Status categories | `backlog\|planning\|in_progress\|blocked\|closed` | Planning is first-class because the imperium-loop pipeline treats plan-generation and build-time as separate phases — collapsing them poisons cycle-time charts. Default project seed includes 4 of 5 statuses; planning is opt-in. |
| Resolution | Separate field, required when `category=closed` | Splits "work complete" (`done`) from "shipped" (`released`) from "abandoned" (`cancelled`) without exploding categories. |
| Transitions | Optional whitelist table | Zero rows = any-to-any. Any rows = whitelist enforced. Lets agents be guard-railed without forcing every project to define a workflow. |
| Ticket IDs | `KEY-NUMBER` (e.g. `SWY-47`), per-project counter | Human-readable in commits/PRs/n8n flows. Project key immutable after creation. UUIDs as canonical IDs underneath. |
| Epic hierarchy | Epic → non-epic only, one level deep | Postgres trigger enforces the cross-row invariant. Future "super epics" require trigger updates, not now. |
| Actor model | `users` table with `type = agent\|human` | Cleaner than string actor IDs; every API token belongs to a user; audit log shows which agent acted. |
| ID generation | UUID everywhere | User pref. v4 from `gen_random_uuid()` for now; cursor pagination uses `(timestamp, id)` pairs since v4 doesn't sort. |
| Webhooks | HMAC-signed, retry with backoff, delivery log table | Agents depend on these landing; `webhook_deliveries` makes failures visible and `POST .../redeliver` makes recovery one click. |
| Idempotency | Per-`(user, method, path)` key, 24h TTL | n8n retries; without idempotency keys, agents create duplicate tickets. |
| Storage | Filesystem (`/data/uploads`) for attachments | Homelab-appropriate. Adapter pattern allows S3 swap if the constraints change. |
| Operational | Exit non-zero on bad config / DB unreachable | Vikunja's password-drift bug is the cautionary tale: silent recovery into a broken state is worse than a clear restart loop the orchestrator can surface. |
| Watchtower | Opted out (`enable=false` label) | Same reason. Updates are explicit deploys. |
| Migrations | Drizzle Kit + custom `triggers.sql` | Drizzle handles tables/columns/indexes; the trigger SQL covers cross-row constraints Drizzle can't express. |
| Rule execution (Phase 4) | Async via in-process dispatcher, mirrors `webhooks/dispatcher.ts` | Reuses a proven pattern (FOR UPDATE SKIP LOCKED, backoff, attempts, redeliver). Bounded request latency. No in-band recursion risk. |
| Rule loop prevention (Phase 4) | Rules skip events authored by `rules-engine` system user | Simpler than depth-bounded causation chains; chains aren't needed until they are. |
| Rule actor (Phase 4) | Single `rules-engine` canonical agent user | Audit log cleanly distinguishes rule-authored events from human/agent actions; one user keeps event-eligibility filtering simple. |
| Rule condition DSL (Phase 4) | Flat JSONB, `eq/ne/in/not_in/contains/is_null/is_not_null`, one level of `all`/`any` | Strong enough for daily rules without inventing a parser; flat enough that the form-based UI stays honest. |
| Rule action retry (Phase 4) | Auto-retry on infra errors only; action-internal failures stop without retry | Infra-flake should self-heal; a rule whose `move_status` is rejected by the transitions table shouldn't keep hammering. Admin redelivers explicitly. |
| Transition guards (Phase 4) | Out of scope; hardcoded epic-close stays | Guards are sync-and-reject — a different shape from async after-the-fact rules. Revisit when daily use surfaces the needed primitives. |
| Authz model (Phase 6) | Two-dimensional: token scopes ∩ per-project role; reads 404 (not 403) for non-member resources | Adds the project dimension the global-scope model lacks without discarding scopes. 404-on-read avoids leaking the existence of projects/tickets a viewer can't see. |
| User roles (Phase 6) | Instance `owner\|member` + per-project `admin\|editor\|viewer`; agents are instance-wide service accounts | Lets a human be scoped read-only to one project while agents keep cross-project access, so imperium-loop is untouched. |

## Non-goals (deliberately out of scope)

- **Multi-tenant**. Single-instance, single-org. Phase 6 adds multi-*user* (project-scoped humans within the one org); true multi-*tenant* (isolated orgs) stays out.
- **OAuth / SSO**. Bearer tokens remain the auth mechanism even with multiple humans (Phase 6) — admins mint per-user tokens, shared via the SWY-63 QR flow. No external identity provider.
- **Real-time collaborative editing**. Markdown, save-on-blur. Not Notion.
- **Sprints / agile ceremonies**. The user runs an agentic pipeline, not a scrum team.
- **Email notifications**. Discord (via Autosavant) and direct webhooks cover this.
- **Markdown rendering on the server**. Client renders; server stores raw markdown. Cleaner, less attack surface.

## Imperium-loop migration ✅

Cutover complete (2026-05-14). Vikunja decommissioned, both Cogitation Engine and Vox-Dictate workflows now run against Switchyard end-to-end.

What landed in `~/imperium-loop/`:

1. `tools/cogitation-patch/migrate-to-switchyard` — single Go subcommand that surgically rewrites a Vikunja-shape workflow JSON to Switchyard shape (removes the `Vikunja Login` node, replaces JWT-bearer expressions with per-actor token env refs, swaps bucket-move HTTP nodes for `/transition` POSTs, comment nodes for the `{body}` payload shape, inserts `Parse Trigger` / `Fetch Full Ticket` / `Switchyard Status Lookup` prep block, attach-external-ref + Move to PR Open after PR creation, Move to Rejected on failure paths). Idempotent on an already-migrated workflow.
2. `workflows/vox-dictate.json` — new n8n workflow built fresh (no Vikunja predecessor): Drive trigger → mammoth-based `.docx`/text extract → live project-list fetch → Gemma 4 Scribe with project-routing prompt → Parse + idempotency-fingerprint → Switchyard ticket POST → triage comment if project routing was uncertain.
3. **Trigger model flipped**: pickup gate is now the `ready-for-agent` label on a backlog-category ticket (was: kanban bucket move). Webhook subscription is `ticket.updated` with no server-side status filter; the label gate runs in n8n.
4. **Pipeline state machine** uses the seeded status set per project (Backlog → Planning → Awaiting Plan Review → Building → PR Open → Shipped → Rejected). `PR Open` is the new pipeline-terminal state on success; `Shipped` is set by a Switchyard automation rule on `ticket.external_ref_state_changed (kind=github_pr, new_state=merged)` — the pipeline doesn't drive close.
5. **Per-actor tokens** in use end-to-end: `n8n-cogitation` for the Cogitation Engine, `n8n-vox-dictate` for Vox-Dictate. Audit logs attribute correctly.
6. Custom fields declared at the global scope: `repo_url`, `mode`, `test_cmd`, `template`, `scaffold_project`, `discord_thread_id`, `cogitation_run_id`, `refinement_attempts`, `high_review_verdict`.

Verified end-to-end on the failure path (LOOP-1 → normalization fail → comment + Move to Rejected) and on the Vox-Dictate path (transcript → SWY-53 with structured Summary/Goals/Approach/Open-questions description). Success path (modify → diff → PR → external-ref attach → rule auto-close on merge) wired but not yet exercised against a real repo — that's the next test once the bake-off model selection lands.

## Imperium-loop follow-ups (post-migration)

Tracked here because they share the Switchyard surface area exercised in the migration; concrete implementation lives in `~/imperium-loop/`.

- **IL-1 — Bake-off model swap ✅.** `gemma4:e4b` → `gemma4:31b` across Vox-Dictate Scribe, Cogitation Engine normalizer, modify-mode diff gen, and refinement retry. Per bake-off (`~/construct-server/docs/bakeoffs/2026-05-16-amd-r9700-launch.md`): 31b lands at ~88% of Claude on autonomous codegen at $0 marginal cost. e4b retained as utility-only. Workflow JSON updated in commit `09665cb`; n8n reimport + reactivation done same session.
- **IL-2 — Greenfield-end reviewer split ✅.** Pocock-style context drop after `run_greenfield_agent` finishes. The implementing agent that just spent up to 30 tool-use turns is making the "is this done" decision deep in sedimented context; a fresh Anthropic client with system prompt only renders that verdict instead. Shipped in commit `de3567e`: new `verify_greenfield` MCP tool in servo-signal (Claude Opus 4.7 by default, `VERIFY_MODEL` override), and a new `add-greenfield-verify` patcher subcommand that inserts `Build Verify Request → Verify Greenfield → Parse Verification → Verification Passed?` between `Greenfield Complete? (true)` and `Build Greenfield Review Payload`. Verifier-rejected runs short-circuit to `Rejected` with the concerns list as a comment before the (more expensive) High Review fires. Idempotent patcher; composes with `migrate-to-switchyard`.
  - **IL-2 v2 — Verifier-as-subagent with Switchyard MCP (future refactor, not blocking).** Now that Switchyard MCP is live (Phase 5.0 / SWY-36) and hardened by SWY-60 (live smoke) + SWY-61 (error-path coverage), the verifier can be reframed: spawn a fresh Anthropic session with both servo-signal MCP (for `filesystem_read`) and Switchyard MCP (for `get_ticket` / `comment_on_ticket`) attached, hand it just the ticket key, let it gather its own evidence and post its own verdict. Cleaner separation: verifier owns evidence-gathering instead of being fed pre-extracted strings, and n8n's role shrinks to "kick off the verifier" rather than "extract context, call MCP tool, parse JSON, post comment." The MCP layer is production-quality now so the refactor risk is mostly on our side. Wait until the current implementation has run a few real tickets before refactoring — the existing pre-extraction path is fine and may be cheaper at inference time (less tool-loop overhead).
- **IL-3 step 1 — `LLMBackend` interface extraction ✅.** Shipped in commit `774547c`. New `servo-signal/llm_backend.go` defines the canonical interface (`Generate(ctx, LLMRequest) → LLMResponse`) and provider-neutral types (`LLMRequest` / `LLMResponse` / `ToolSpec`, canonical stop-reason string constants). `servo-signal/anthropic_backend.go` extracts the existing Anthropic SDK code as the sole `LLMBackend` impl. `servo-signal/greenfield.go` now provider-agnostic — no SDK imports, `runGreenfieldLoop` takes an `LLMBackend` argument, `selectBackend()` centralizes construction + env validation. `greenfieldSession.Backend` field records which backend ran. Behavior unchanged: same default model, same MCP surface (verified via `tools/list`), same persistence schema. Full design doc at `~/imperium-loop/docs/il-3-design.md`.
- **IL-3 step 2 — `OllamaBackend` impl ⏳ deferred.** Originally planned to follow step 1; explicitly parked. Justification: Ollama's prompt-templated tool calling for non-tool-native models (Gemma 4 lineage) produces the exact failure modes the design doc predicts — malformed `tool_calls.arguments` JSON, dropped/wrong `tool_call_id` values, silent fallback to plain-text "I'll call list_files" hallucinations. Confirmed in the wild via Cline + Claude Code harness sessions with `gemma4:31b`. The design doc's defensive parsing strategy (treat malformed tool_use as a tool_result with `isError: true` and let the model self-correct) is technically buildable but the per-turn retry overhead probably wipes out any quality win against running Claude Sonnet 4.6 directly. Revisit when either (a) a tool-native local model with comparable codegen quality lands in Ollama's catalog (gpt-oss family is closest today but loses to Sonnet on the bake-off), or (b) cost pressure forces local-first and we're willing to invest in the defensive layer. *Independent of backend choice*, when step 2 lands the agent loop can also announce Switchyard MCP (Phase 5.0) as an additional tool surface alongside `list_files` / `read_file` / `write_file` / `run_cmd` — lets the agent read its own ticket and post status updates mid-loop. Same fragility caveat applies: a local model struggling to emit one MCP surface reliably will struggle with two.
- **IL-3a — Deterministic guard rails in the greenfield loop ⏳.** Locked: hard wrapper, not polite instruction. After every `write_file`, the loop runs `lint_cmd` (per-runtime default: `go vet ./... && gofmt -l .` for Go, `eslint .` for Node, `cargo clippy` for Rust) and prepends the lint output to the next tool_result. If lint fails, the write is still committed (so the model sees its own attempt) but the next turn carries a hard "lint failed, fix before proceeding" preamble. Before the model can emit a final `stop_reason=end_turn`, the loop runs the planning agent's `test_oracle` command if present, and on failure forces another turn with the test output. Applies to both backends; the Anthropic path benefits less but it's free safety. Wrapper logic runs in the agent loop, not the LLM — orthogonal to whether Switchyard MCP is attached.
- **IL-4 — Greenfield + Switchyard project creation ⏳.** Scaffold flow creates a GitHub repo + initial commit but never creates a Switchyard project to track follow-on tickets against the new repo. Locked: new MCP tool `create_switchyard_project` in servo-signal, called from the Cogitation Engine workflow the same way `create_github_repo` is today. Tool reads `SWITCHYARD_TOKEN` (servo-signal actor token, see per-actor mapping in `~/imperium-loop/CLAUDE.md`) and calls `POST /v1/projects` with `{key, name, description, repo_url}`. Pairs with IL-5 — only fires on graduation, not on every scaffold.
- **IL-5 — `INCUBATOR` project + graduation lifecycle ⏳.** Locked: a seed `INCUBATOR` Switchyard project catches (a) Vox-Dictate output whose Scribe couldn't confidently route (replaces the current "fallback to LOOP" path), (b) all scaffold-mode tickets at creation time (the new repo doesn't yet have its own project). Graduation rule: Switchyard automation rule (Phase 4) counts open + closed tickets attached to the same `repo_url` custom field; when count ≥ 3, fires `call_n8n` to a new Autosavant prompt asking "graduate `<repo>` to its own project?". On approval, n8n calls servo-signal's `create_switchyard_project` (IL-4), then Phase 4.10 `move ticket` migrates the related tickets (key aliases preserved automatically). Net new Switchyard surface: none — `POST /v1/projects` + `POST /v1/tickets/{key}/move` + the rule action catalog all exist. New imperium-loop work: Vox-Dictate Scribe prompt updated to route to `INCUBATOR` on uncertainty (instead of LOOP), Cogitation Engine scaffold branch creates tickets in `INCUBATOR` by default, new Autosavant prompt + thread for graduation review.
  - **⚠ Switchyard dependency (now surfaced on the Phase 5 candidates queue):** the graduation rule needs cross-ticket aggregation in the rule DSL ("count tickets where `metadata.repo_url = X`"). Now tracked in Phase 5 "Candidates queued but not yet ticketed" as **"Cross-ticket aggregation in rule conditions"** — flagged-by-IL-5. The Phase 4 condition catalog (`eq/ne/in/not_in/contains/is_null/is_not_null` over the current event payload) can't express this. Two paths and no decision yet — flagged on the IL-5 ticket when it's created:
    - **Small Phase 4 extension:** add a `count` condition op that runs a bounded ticket query (e.g. `{ count: { custom_field: "repo_url", value: "{{ticket.metadata.repo_url}}", op: ">=", n: 3 } }`) against an indexed shape. Keeps the rule single-trigger and atomic.
    - **Phase 5 plugin:** imperium-loop's plugin endpoint exposes the count; Switchyard rule conditions consume plugin-returned values. More flexible, more moving parts.
    - **Fallback (no Switchyard work):** Phase 4.2 scheduled rule with `target_query` fires once per matching ticket; the n8n side debounces and threshold-checks. Clumsy at threshold counting (no atomic "first time we cross 3").
