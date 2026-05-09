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

**Shipped.** All 7 milestones (1.0–1.6) plus a correctness/DRY closeout pass. The imperium-loop migration is unblocked from switchyard's side; only `tools/cogitation-patch/` work remains on that front.

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

## Phase 2 — Frontend

Goal: the user can do everything via the UI that they'd otherwise do via curl. Linear-density + ClickUp/Monday color richness; skeleton loaders; drawer ticket detail with deep-linkable URLs.

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

### Milestone 2.0 — Foundations

- Materialize `client/src/lib/api.types.ts` via `bun run api:gen`.
- Install shadcn-vue components for the shell (button, input, label, card, avatar, dropdown-menu, separator, scroll-area, sonner, sheet, skeleton).
- Add deps: `markdown-it`, `date-fns`, `vee-validate`, `@vee-validate/zod`, `@atlaskit/pragmatic-drag-and-drop` family (deferred to 2.4 if not needed yet).
- Layout shell: sidebar (projects + nav) + topbar (user menu, theme toggle) + main content slot. Empty placeholders inside.
- Pinia stores: `useThemeStore` (light/dark via `@vueuse/core` `useColorMode`), placeholder `useAuthStore`.
- TanStack Query setup: client config, key conventions (`['users','me']`, `['projects']`, `['tickets', filters]`, `['ticket', idOrKey]`, `['boards']`, `['board', id, 'columns']`).
- Top-level error boundary that surfaces API error envelopes via Sonner.

### Milestone 2.1 — Auth flow

- `/login` view: token textarea, validates against `GET /v1/users/me`. On success, stores in localStorage (already wired by the `api.ts` middleware) and redirects to `/`.
- `useAuthStore` derives the logged-in user from `useQuery(['users','me'])`.
- Route guard: redirect unauthenticated to `/login`. Logout clears storage and invalidates queries.
- Topbar shows the user's avatar + dropdown (theme toggle, settings, logout).

### Milestone 2.2 — Tickets list

- `/tickets` route. URL drives filter state (`?project=FLOW&status=in_progress`).
- Filter bar: chips for status-category / type / priority; comboboxes for project / label / assignee; text search (debounced 250ms).
- Virtualized table (TanStack Virtual) with columns: key, type icon, title, status pill, priority, assignee avatar, label badges, updated relative.
- Cursor pagination via `useInfiniteQuery`; "Load more" sentinel triggers `fetchNextPage`.
- Click row → drawer opens with ticket detail (2.3) and `?focus=KEY-N` query param appended.

### Milestone 2.3 — Ticket detail (drawer + page)

- Right-side `Sheet` drawer with tabs: Description / Comments / Files / Activity.
- Description: markdown render via markdown-it with DOMPurify; edit via inline textarea + save.
- Comments: list with author avatar + relative timestamp; markdown body; composer at bottom with file-drop zone (uploads via the multipart endpoint).
- Files: ticket attachments + comment attachments grouped, with download links and (for audio) transcript display.
- Activity: events list with field-level diff rendering for `ticket.updated`, status pill transitions for `ticket.status_changed`, etc.
- Header actions: status transition button (opens menu of allowed transitions; presents resolution selector when target is closed); priority dropdown; assignee picker.
- Standalone `/tickets/:idOrKey` route renders the same drawer over a blank background for direct deep-link access.

### Milestone 2.4 — Kanban board (single-project)

- `/projects/:key/board` route.
- Columns by canonical category (Backlog / Planning / In Progress / Blocked / Closed). Display-name aliases shown in column header.
- Card: ticket key (monospace), title, type icon, assignee avatar, priority pill, label dots.
- pragmatic-drag-and-drop: drag → `POST /v1/tickets/{id}/transition`. On drop into closed column, prompt for resolution. Optimistic update with rollback on error.
- Per-column virtualization for projects with hundreds of tickets in one column.

### Milestone 2.5 — Cross-project boards + swimlanes

- `/boards` list + `/boards/new` (multi-project select via combobox).
- `/boards/:id` view: kanban with optional **swimlanes** (group rows by project / assignee / epic / type).
- Swimlane picker in the board header; persisted in board.filter or local user prefs.
- Saved filters per board (types, priorities, label_ids, assignee_ids).
- Cross-project drag is allowed when target column resolves to a status the receiving project actually has; otherwise rejected with a toast.

### Milestone 2.6 — Settings

- `/settings/profile` — me, avatar (URL field for now), display name.
- `/settings/tokens` — list / create / revoke own tokens.
- `/settings/users` (admin) — user CRUD.
- `/settings/projects` — list / create. Per-project sub-pages: statuses (with reorder + is_default toggle), transitions (graph editor lite), members (skipped if multi-user not enabled yet).
- `/settings/labels` — global label catalog (a single shared list across all projects). CRUD with name + color picker.
- `/settings/webhooks` — subscriptions + delivery log. Redeliver button on failed deliveries. Show secret on creation banner.

### Milestone 2.7 — Polish

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
- **Project ↔ repo linking + PR/commit indicators on cards.** Tie each project
  to one or more GitHub repos, surface PR/commit references on ticket cards
  via a small icon (closed/open/draft PR state, commit count), let agents
  attach PR URLs when they ship work. Likely involves: (a) `project_repos`
  table or `metadata.repos[]` on projects, (b) `ticket_links` table for
  PR/commit refs (URL + state polled or webhook'd), (c) a card slot for the
  GitHub icon + tooltip. Probably Phase 3 alongside dashboards, since the
  data is also useful for "tickets shipped this week" charts.
- **User-defined custom swimlanes.** Today swimlanes group by project /
  assignee / type. Expand to "named groups" — user defines categories like
  "Documentation row" or "Engineering row" and assigns tickets/labels/projects
  to them. Probably stored as `board.filter.swimlane` config plus a tagging
  mechanism. Defer until the basic swimlanes have shipped and we know the
  shape we want.

## Phase 3 — Dashboards & polish

Goal: the "how much work is left, how much done over time" view.

Locked breakdown:

- **3.0 — Stats/aggregation backend.** `GET /v1/projects/:key/stats` (counts + by_category/priority/type/assignee + stale_in_progress + most_recent_activity), `GET /v1/stats/projects` (bulk feed for the directory), `GET /v1/stats/throughput` (closed-per-period over a window), `GET /v1/stats/cycle-time` (in_progress duration distribution; in_progress only — blocked excluded by design). Plus `system_settings` table + `GET/PATCH /v1/settings` for runtime config (default `stale_in_progress_days = 30`). All event-scan endpoints capped at 5000 events; 400 if exceeded. Side effect: ProjectsView ticket-count column lights up.
- **3.0b — Cumulative flow.** `GET /v1/stats/cumulative-flow` for burndown + CFD charts. Split out because the per-bucket category replay over events is ~half the work of the other four combined. **CFD endpoint cap is 50,000 events** (vs. 5,000 for the other stats endpoints) since CFD inherently must scan project history, not just the window.
- **3.1 — Dashboards.** Chart lib: **Apache ECharts via vue-echarts** (may roll our own later for visual polish). See "3.1 — Dashboards in detail" below for widget-level specs.
- **3.2 — Power tools on tickets list.** Saved views (`saved_views` table, CRUD, palette integration) + bulk operations (multi-select, bulk-edit labels/assignee/status).
- **3.3 — Notifications / @mentions.** Persistent notifications surface — `notifications` table, `mentioned_user_ids` extracted on comment/description write, dedicated unread/seen state, mark-as-read endpoint, dropdown in topbar, deeper integration with the homepage panel that 3.1 ships as a basic live-scan placeholder.
- **3.4 — Polish & a11y.** Empty-state audit, skeleton-loader audit, keyboard-nav per-view (`j/k` on tickets list, `←/→` between board columns), aria audit, configurable Projects columns, command palette `=`-token autocomplete, configurable widget visibility on Insights tabs.

Locked Phase 3 decisions:

- **Cycle time counts in_progress only**, not blocked. Blocked time is its own future metric (companies tracking SLAs would care; personal use mostly doesn't).
- **Stale-in-progress threshold is a global system setting**, default **30 days** (low for personal use; lower for SLA-sensitive deploys).
- **Event-scan endpoints bounded at 5000 events** per request, 400 if exceeded — never silently truncate.
- **ECharts now**, may roll custom later if visual polish demands it.

Deferred from Phase 3 → Phase 5:

- **SSE / real-time updates.** Current 30s `refetchInterval` (shipped in 2.7) is acceptable for now. Revisit if "agent moved a ticket but my UI doesn't know" feels laggy in practice.

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

## Phase 4 — Native automation rules

Goal: replace n8n for simple "if status = X, do Y" rules. n8n keeps the complex flows.

- **Rules schema:** `rules (id, project_id, trigger_event, conditions JSONB, actions JSONB, enabled, last_fired_at)`.
- **Trigger types:** event-based (any `event_type`) and scheduled (cron, single goroutine evaluating all scheduled rules).
- **Condition DSL:** small, JSON-encoded — `{"and": [{"field": "ticket.status.category", "op": "eq", "value": "closed"}, ...]}`.
- **Actions:** `set_field`, `add_label`, `comment`, `assign`, `move_status`, `fire_webhook`, `call_n8n` (convenience wrapper).
- **Audit:** every rule firing writes to `events` with `actor_id` referencing a system "rule" user.
- **UI:** rule editor in settings; recent firings panel for debugging.

This is also where pluggable transition guards land (e.g., user-defined "epic can't close while children open" — currently hardcoded). Those become rules-as-guards.

## Phase 5 — As demanded

No pre-design. Track candidates here as they come up:

- **Multi-user** (project_members + RBAC). Currently single-user + agents; will be needed if anyone else logs in.
- **S3-compatible attachment storage** — only if filesystem becomes painful (size, sharing across multiple containers, off-host backup).
- **Sprints / cycles** — only if the workflow benefits from time-boxed planning. Probably not.
- **Time tracking** — only if asked.
- **Ticket templates** — likely useful sooner than later for the agentic pipeline (canonical "modify" / "scaffold" / "greenfield" ticket shapes).

---

## Locked architectural decisions

These were settled during planning. Don't relitigate without naming the *why* listed here.

| Decision | Choice | Reason |
|---|---|---|
| Backend lang | Hono on Bun | Type-share with frontend via Zod; Bun's memory profile is closer to Go than Node-Express; the user already runs n8n so the runtime isn't foreign. |
| Frontend lang | Vue 3 (not React) | User preference, stated explicitly. Default for all switchyard frontend work. |
| Container shape | Single container | Hono serves API + Vue static. No CORS, no nginx, simpler deploy. |
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

## Non-goals (deliberately out of scope)

- **Multi-tenant**. Single-instance, single-org. If this changes, it's a Phase 6 conversation.
- **OAuth / SSO**. Bearer tokens are sufficient for one human + N agents.
- **Real-time collaborative editing**. Markdown, save-on-blur. Not Notion.
- **Sprints / agile ceremonies**. The user runs an agentic pipeline, not a scrum team.
- **Email notifications**. Discord (via Autosavant) and direct webhooks cover this.
- **Markdown rendering on the server**. Client renders; server stores raw markdown. Cleaner, less attack surface.

## Imperium-loop migration

Tracked separately in `~/imperium-loop/`, not in switchyard. The plan there:

1. Phase 1 lands → switchyard is functional alongside Vikunja.
2. `tools/cogitation-patch/` gets a `swap-to-switchyard` subcommand: rewrites `http://vikunja:3456/api/v1/...` → `http://switchyard:4002/v1/...`, replaces JWT login with static bearer token, adjusts payload shapes (POST comments uses POST not PUT, status moves use the typed `/transition` endpoint, etc.).
3. Run side-by-side; cut over the cogitation engine.
4. Decommission Vikunja.

Switchyard's API surface is intentionally at least as expressive as Vikunja's so that step 2 is mostly mechanical.
