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
