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

## Phase 1 — Backend MVP

Goal: a real, usable API. The imperium-loop migration becomes possible at the end of this phase.

In scope:

- **Bootstrap-token-on-first-boot** path. If `api_tokens` is empty at startup, generate one admin token and print it to logs once. User mints real per-user tokens, then revokes the bootstrap.
- **Pre-seed users** on first migration: `magos` (human), `claude` / `n8n-cogitation` / `n8n-vox-dictate` / `servo-signal` / `autosavant-bot` (agent).
- **Implement handlers** for: projects, statuses, transitions, labels, users, tokens.
- **Implement tickets**: CRUD + transitions (validates `status_transitions` table + epic-children-closed guard) + per-project `number` allocation via `project_counters` (txn-safe).
- **Comments + attachments** (filesystem storage at `UPLOAD_DIR`, mime-sniffed, served via token-guarded download route).
- **Events table** writes on every mutation. The same row is the source of webhook payloads, audit history, and chart data.
- **Outbound webhook fan-out:**
  - Inline goroutine-style fan-out on event commit (no separate worker process; an in-process queue with retry).
  - HMAC signing (`X-Switchyard-Signature: sha256=<hex>`).
  - Retry with exponential backoff (5 attempts: 1s/4s/16s/64s/256s).
  - `webhook_deliveries` rows for every attempt; `POST /v1/webhooks/deliveries/{id}/redeliver` for manual retry.
- **Idempotency keys** on POSTs (`Idempotency-Key` header → `idempotency_keys` table, scoped per `(user, method, path)`, 24h TTL, returns the cached response on replay).
- **Cursor pagination** on every list endpoint (`(updated_at DESC, id DESC)`-based cursor).
- **Tests** — integration tests against a real Postgres (testcontainers or compose-side fixture), no DB mocks. Cover: ticket CRUD, transition guards, idempotency, webhook signing.

Out of scope (defer to later phases):
- UI (Phase 2)
- Charts / dashboards (Phase 3)
- Native automation rules (Phase 4)

## Phase 2 — Frontend skeleton

Goal: the user can do everything via the UI that they'd otherwise do via curl.

- Generated TS client from `openapi.yaml` (`openapi-typescript` + `openapi-fetch`), wired into TanStack Query Vue.
- **Login** — single token field, stored in `localStorage` for now (SSO/OAuth not in scope here).
- **Tickets list** with filter chips (project, status category, type, label, assignee, text search) — mirrors the `GET /v1/tickets` filter API.
- **Ticket detail** with tabs (description / comments / files / activity), markdown rendering, comment composer with file drop, audio preview placeholder.
- **Kanban board** — columns by status category; drag → `POST /v1/tickets/{id}/transition`.
- **Project switcher** + the cross-project boards UI (the "17 projects" use case).
- **Settings** — manage statuses, labels, transitions, webhooks, tokens, users.
- Dark mode (already wired in Tailwind config).
- Command palette (cmd-K) — minimum: jump to ticket by key, quick-create ticket.

Out of scope:
- Charts (Phase 3)
- Real-time updates via SSE/websocket (Phase 3 candidate; until then, TanStack Query refetch + manual refresh)

## Phase 3 — Dashboards & polish

Goal: the "how much work is left, how much done over time" view.

- **Charts** derived from `events`: burndown per board, throughput (closed/week), cycle time per type, status distribution, plan→build→close funnel.
- **Per-project dashboard** + **per-board dashboard** + **personal "my work" dashboard**.
- **Saved views** (extend boards with stronger filter expressions).
- **Bulk operations** — select N tickets in the list, bulk-edit labels/assignee/status.
- **Real-time updates** via SSE — minimal: ticket-list views reload when relevant events fire. Removes the "agent moved a ticket but my UI doesn't know" friction.
- Polish pass: empty states, skeleton loaders, keyboard nav, accessibility audit.

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
