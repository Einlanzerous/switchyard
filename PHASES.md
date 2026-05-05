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

Goal: a real, usable API. The imperium-loop migration becomes possible at the end of this phase. Broken into 7 milestones so each lands a usable intermediate state.

### Locked decisions for Phase 1

- **Webhook dispatcher:** in-process polling loop with `FOR UPDATE SKIP LOCKED`. Survives missed notifications without a permanent connection.
- **Test database:** approach (a) — `switchyard_test` DB on construct's existing Postgres, devs pass `DATABASE_URL_TEST`. Cheaper than spinning up an ephemeral container.
- **Attachment size caps (configurable via env):** image 25MB, audio 100MB, text 5MB. Adjustable via `ATTACHMENT_MAX_*_BYTES` env vars.
- **Default project status seed: 5 statuses** — Backlog, Planning, In Progress, Blocked, Closed. Planning is included because it's a first-class enum value; projects that don't use it can delete their Planning status.
- **Bootstrap token UX:** explicit `BOOTSTRAP_TOKEN` env wins. If unset and `api_tokens` is empty on boot, auto-generate one and log it once with a clear delimiter; also write it to `${UPLOAD_DIR}/.bootstrap-token` for one-shot retrieval.
- **TS client codegen:** `client/src/lib/api.types.ts` is generated from `openapi.yaml` and **committed** for diff visibility on PRs. Regenerated explicitly via a script, not at build time.

### Milestone 1.0 — Foundations (no handlers yet)

All cross-cutting infrastructure handlers will use, plus tests. No business endpoints implemented.

- Initial Drizzle migration generated and committed (`server/drizzle/migrations/`).
- `migrate.ts` extended: drizzle migrations → `triggers.sql` → `seed.ts`.
- `seed.ts` — idempotent: 6 canonical users + bootstrap token (per locked UX above).
- `lib/pagination.ts` — opaque cursor codec + `paginate()` helper.
- `lib/idempotency.ts` — per `(user, method, path, key)` middleware with 24h TTL + lazy cleanup.
- `lib/events.ts` — `writeEvent()` writes events row AND enqueues matching webhook deliveries in the same transaction.
- `lib/webhooks/dispatcher.ts` — polling loop, HMAC signing, backoff (1/4/16/64/256s), abandon after 5 attempts, graceful drain on SIGTERM.
- `lib/scopes.ts` — formal route → required scope mapping (consumed by tests).
- `lib/hmac.ts` — HMAC-SHA256 signing helper.
- Test harness: `db:test:setup` script, transaction-rollback isolation, sample tests for pagination/idempotency/hmac.

**Done when:** migrations apply cleanly, seed runs idempotently, bootstrap token surfaces once, idempotency replay works in a unit test, fake event with fake subscription delivers end-to-end in a test.

### Milestone 1.1 — Read-only API

Implement read handlers for: `users`, `users/me`, `projects`, `projects/{key}/statuses|labels|transitions`, `tickets` (full filter + cursor pagination), `tickets/{idOrKey}` (full detail with embedded comments + flattened all_attachments), `tickets/{idOrKey}/events|children|comments`, `events`, `boards`, `boards/{id}`, `boards/{id}/columns`, `attachments/{id}/meta`. POST/PATCH/DELETE remain 501.

Key piece: ticket-key resolver (`SWY-47` → split → find project → query by `(project_id, number)`).

**Done when:** smoke tests pass against a seeded DB; `curl /v1/tickets?project=SWY` returns paginated results matching the OpenAPI spec.

### Milestone 1.2 — Project / admin mutations

Project, status, transition, label, user, token CRUD. POST endpoints run through idempotency middleware. Each mutation calls `writeEvent`.

`POST /v1/projects` is the heaviest: in one transaction, insert project, insert `project_counters` row, insert 5 default statuses (Backlog/Planning/In Progress/Blocked/Closed), set `is_default` on Backlog.

Key field is immutable (PATCH rejects it with 422). Soft-delete on DELETE.

**Done when:** can curl-create a project, get statuses, add a label, mint a token, revoke it. Replaying any POST with the same `Idempotency-Key` returns the cached response.

### Milestone 1.3 — Tickets + comments + attachments

The hot path. Ordered work inside the milestone:

1. `POST /v1/tickets` — txn: validate project; increment `project_counters.last_used_number` (renamed from `next_number`); resolve default status; validate parent (epic, same project, not deleted; trigger backstops); validate assignee; insert ticket + ticket_labels; emit `ticket.created`.
2. `PATCH /v1/tickets/{idOrKey}` — partial; emits `ticket.updated` with `changes.fields[]` diff. Status-change additionally emits `ticket.status_changed`.
3. `POST /v1/tickets/{idOrKey}/transition` — typed wrapper. Validates `status_transitions` (whitelist or wildcard). Requires `resolution` if target category is closed. **Epic-close guard:** rejects 422 with the list of non-closed children if epic close is attempted with open children.
4. `DELETE /v1/tickets/{idOrKey}` — soft + `ticket.deleted` event.
5. Comment CRUD with events.
6. Attachments: multipart upload via Bun, mime-sniff, per-kind size caps from env, write to `${UPLOAD_DIR}/yyyy/mm/<uuid>.<ext>`, emit `attachment.added`. Token-guarded streamed download. Delete removes row + best-effort file unlink.

**Done when:** Vox-Dictate-style flow works end-to-end: create ticket, attach audio + transcript, GET returns everything embedded.

### Milestone 1.4 — Webhooks

`POST /v1/webhooks` mints secret (returned once). PATCH/DELETE/GET. `GET .../{id}/deliveries` paginated log. `POST .../deliveries/{id}/redeliver` flips status to `pending`. Dispatcher loop (already running from 1.0) is now exercised end-to-end. Add integration test: subscribe → trigger event → assert mock endpoint receives valid HMAC.

**Done when:** Cogitation Engine could be retargeted at switchyard pending the cogitation-patch URL/payload swap.

### Milestone 1.5 — Boards (write)

`POST/PATCH/DELETE /v1/boards`. Empty project list rejected. Performance test of `GET /v1/boards/{id}/columns` with 10 projects × 100 tickets; add indexes if slow.

**Done when:** create a board scoped to N projects and see its kanban columns under load.

### Milestone 1.6 — Polish + ops

- `/healthz` deepens: DB ping + `UPLOAD_DIR` writable + queue depth (warn > 1000 pending).
- Structured access logs (JSON; method/path/status/duration_ms/user_id/request_id).
- Graceful shutdown drains dispatcher with 5s deadline.
- `client/src/lib/api.types.ts` generated from `openapi.yaml` and committed.
- README: "How agents use this API" — idempotent POST example, webhook signature verification snippets.

**Done when:** Phase 1 complete. The cogitation engine can be migrated at this point.

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
