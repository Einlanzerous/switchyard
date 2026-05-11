# switchyard

<img src="client/src/assets/switchyard_logo_large_unboxed_concept.png" alt="Switchyard" width="300" />

Self-hosted ticketing / project-management system. API-first, agent-first. Replaces Vikunja in the Imperium-Loop pipeline.

## Stack

- **Server:** Hono on Bun, Drizzle ORM, Zod schemas (single source of truth for validation + OpenAPI + shared types).
- **Client:** Vue 3 + Vite + TypeScript + Tailwind + shadcn-vue + Pinia + TanStack Query.
- **Database:** PostgreSQL 16 (shared instance on `construct_net`).
- **Deploy:** Single container — Hono serves the API at `/v1/*` and the built Vue client at `/`.

## Layout

```
switchyard/
├── server/             Hono + Drizzle backend
├── client/             Vue 3 frontend
├── shared/             Zod schemas + derived TS types (consumed by both)
├── compose-changes/    Proposed diffs for ~/construct-server
├── Dockerfile          Multi-stage build
└── openapi.yaml        Generated from server route definitions
```

## Development

```bash
bun install
bun run typecheck       # tsc -b shared server client (composite project)
bun run db:generate     # generate Drizzle migrations from schema changes
bun run db:migrate      # apply migrations + triggers + seed to $DATABASE_URL
bun run dev:server      # API on :4002
bun run dev:client      # Vite dev server on :5173, proxies /v1 to :4002
bun run openapi:gen     # writes openapi.yaml from the live route registry
bun run api:gen         # also regenerates client/src/lib/api.types.ts (committed)
```

Tests:

```bash
# One-time: create the test DB (see compose-changes/README.md) then:
bun --cwd server run db:test:setup
bun --cwd server run test:unit         # pure helpers (pagination, hmac)
bun --cwd server run test:integration  # seed + webhook end-to-end (needs DATABASE_URL_TEST)
```

## Status

**Phase 1 (Backend MVP) is shipped.** All 7 milestones (foundations / read API / admin mutations / tickets+comments+attachments / webhooks / board mutations / polish) plus a correctness+DRY closeout pass. The cogitation engine in `~/imperium-loop/` can be retargeted at switchyard once `tools/cogitation-patch/` learns the new URL/payload shape. See [`PHASES.md`](./PHASES.md) for the full plan and architectural decisions.

What works today:

- Full CRUD on projects, statuses, transitions, labels, users, tokens, tickets, comments, attachments, boards, webhooks.
- Ticket detail with embedded comments + flattened all-attachments. Cursor pagination on every list endpoint.
- `/v1/tickets/{id}/transition` with transitions-table whitelist + epic-close guard.
- Multipart attachment upload with magic-byte mime sniffing, per-kind size caps, path-traversal guard, token-guarded streamed download.
- Outbound webhooks: HMAC-signed POSTs, exponential backoff, abandon after 5 attempts, redelivery API, end-to-end integration test.
- Idempotency keys on all POST/PATCH/DELETE (24h TTL).
- `/healthz` reports DB latency / uploads writability / webhook queue depth.
- Structured JSON access logs with `X-Request-ID` echo.
- Graceful shutdown drains the dispatcher within a 10s deadline.

Phase 2 (frontend) is next.

## How agents use this API

### Authentication

Every `/v1/*` request needs a bearer token. Tokens belong to a user (`POST /v1/users/{id}/tokens`); the plaintext is returned **once** at creation. Store it in n8n credentials, the agent's env, etc., and never log it.

```bash
curl -H "Authorization: Bearer sw_..." http://switchyard:4002/v1/users/me
```

### Idempotency

Every POST/PATCH/DELETE accepts an `Idempotency-Key` header. Replays within 24h return the original cached response (status + body) — agents can retry safely without creating duplicates.

```bash
KEY=$(uuidgen)
curl -X POST -H "Authorization: Bearer $TOK" -H "Idempotency-Key: $KEY" \
  -H 'Content-Type: application/json' \
  http://switchyard:4002/v1/tickets \
  -d '{"project_key":"FLOW","type":"task","title":"automated ticket"}'
# Repeating the call with the same KEY returns the same ticket — not a 409.
```

### Cursor pagination

List endpoints return:

```json
{
  "items": [ /* ... */ ],
  "page": { "next_cursor": "eyJ1Ijoi...", "has_more": true }
}
```

Pass `next_cursor` back in `?cursor=...` to fetch the next page. Treat it as opaque — the format is `(updated_at, id)` pairs encoded base64url, but it can change.

### Error envelope

Non-2xx responses always look like:

```json
{ "error": { "code": "unprocessable", "message": "...", "details": { /* optional */ } } }
```

Codes: `bad_request | unauthorized | forbidden | not_found | conflict | unprocessable | rate_limited | internal | service_unavailable`. Parse `code`, surface `message`.

### Webhook signature verification

Outbound webhooks include `X-Switchyard-Signature: sha256=<hex>` — the HMAC-SHA256 of the request body using the subscription's secret. Verify before trusting the payload.

**Node.js:**

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, rawBody, headerValue) {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const sig = (headerValue ?? "").replace(/^sha256=/, "");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(sig, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

**Python:**

```python
import hmac, hashlib
def verify(secret: str, raw_body: bytes, header_value: str) -> bool:
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    sig = header_value.removeprefix("sha256=")
    return hmac.compare_digest(expected, sig)
```

n8n's Webhook node can do this in a Code step or via header-auth if you embed the secret in a constant header instead.

### Status transitions vs PATCH

`PATCH /v1/tickets/{id}` does NOT change `status_id` — that's intentional. All status changes go through `POST /v1/tickets/{id}/transition`, which enforces:

- the project's transitions whitelist (when defined),
- `resolution` is required iff target category is `closed`,
- the epic-close guard refuses to close an epic with open child tickets (response includes `details.open_children`).

### Filters on `GET /v1/tickets`

Comma-separated values are supported on `project`, `status`, `type`, `label`. Status accepts both UUIDs and category names mixed.

```
GET /v1/tickets?project=FLOW,DEMO&status=in_progress,blocked&type=bug,task&label=<uuid>&assignee=<uuid>&text=login&updated_after=2026-05-01T00:00:00Z
```

`assignee=unassigned` filters tickets with no assignee.

### Request IDs

Every response carries an `X-Request-ID` header. Agents that log API calls should include this in their logs so server-side logs can be cross-referenced.

## Deployment notes

- Reads `DATABASE_URL` once at startup; if Postgres is unreachable, the process exits non-zero so Docker reports the failure cleanly (no silent restart-loop into a broken state).
- Watchtower is opted out via `com.centurylinklabs.watchtower.enable=false` — updates happen via deploys, not surprise restarts.
- Attachment files live in a named volume mounted at `/data/uploads`; database stores `storage_path` only.

## Webhook payload shape

All outbound webhooks share one envelope:

```json
{
  "id": "evt_<uuid>",
  "event": "ticket.status_changed",
  "occurred_at": "2026-05-02T15:04:05Z",
  "actor": { "id": "<uuid>", "name": "magos", "type": "human" },
  "ticket": { ... full embedded ticket ... },
  "changes": { "status": { "from": {...}, "to": {...} } }
}
```

HMAC signature in `X-Switchyard-Signature: sha256=<hex>` (HMAC-SHA256 of body with the subscription's secret). Event type also in `X-Switchyard-Event` for routing without body parsing.
